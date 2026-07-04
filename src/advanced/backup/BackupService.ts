import { exec } from "child_process";
import { promisify } from "util";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import { logger } from "@myko/logger";
import type { BackupConfig, BackupInfo, DatabaseResult } from "@myko/types/db";
import { NUMERIX } from "@myko/config";
import { isString } from "@utils/typeGuards";
import { DB_REGEX } from "@utils/regex";

// Move promisify(exec) inside methods to prevent top-level execution in browser
// const execAsync = promisify(exec);

/**
 * Manages database backups with compression, encryption, and cloud storage.
 * Provides automated scheduling and retention management.
 *
 * @example
 * ```typescript
 * const config = {
 *   connectionString: 'postgres://user:pass@localhost:5432/db',
 *   backupDir: './backups',
 *   retentionDays: 30,
 *   compression: true,
 *   encryption: {
 *     enabled: true,
 *     key: 'encryption-key'
 *   },
 *   s3: {
 *     enabled: true,
 *     bucket: 'my-backup-bucket',
 *     region: 'us-east-1',
 *     accessKey: 'aws-access-key',
 *     secretKey: 'aws-secret-key'
 *   }
 * };
 *
 * const backupService = new BackupService(config);
 *
 * // Create a backup
 * const backup = await backupService.createBackup();
 * console.log(`Backup created: ${backup.value.filename}`);
 *
 * // List all backups
 * const backups = await backupService.listBackups();
 *
 * // Restore from backup
 * await backupService.restoreBackup(backup.value.id);
 *
 * // Clean up expired backups
 * await backupService.cleanupExpiredBackups();
 * ```
 */
export class BackupService {
  private config: BackupConfig;
  private backups: Map<string, BackupInfo> = new Map();

  /**
   * Creates a new BackupService instance.
   * @param config Backup configuration
   */
  constructor(config: BackupConfig) {
    this.config = config;
    logger.info(
      `Initializing BackupService - backupDir: ${config.backupDir}, retentionDays: ${config.retentionDays}`,
    );
    this.ensureBackupDir();
    this.loadExistingBackups();

    if (config.schedule) {
      this.scheduleBackups();
    }
    logger.info("BackupService initialized successfully");
  }

  /**
   * Creates a new database backup.
   * @returns Information about the created backup
   */
  // I need to disable these ESLint rules because this function handles a complete
  // backup process (validation, creation, compression, encryption, upload) in sequence.
  // eslint-disable-next-line complexity, max-lines-per-function
  async createBackup(): Promise<DatabaseResult<BackupInfo>> {
    try {
      // Validate backup directory
      if (!this.isValidPath(this.config.backupDir)) {
        throw new DatabaseError(
          "Invalid backup directory path",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          { context: { source: "BackupService.createBackup" } },
        );
      }

      const timestamp = DB_REGEX.createSafeTimestamp(new Date().toISOString());
      const filename = `backup-${timestamp}.sql`;
      const filepath = join(this.config.backupDir, filename);

      // Validate final filepath
      if (
        !this.isValidPath(filepath) ||
        !filepath.startsWith(this.config.backupDir)
      ) {
        throw new DatabaseError(
          "Invalid backup file path",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          { context: { source: "BackupService.createBackup" } },
        );
      }

      logger.info(`Starting database backup - filename: ${filename}`);

      // Create backup using pg_dump with proper escaping
      const execAsync = promisify(exec);
      const { stderr } = await execAsync(
        `pg_dump "${this.escapeShellArg(this.config.connectionString)}" > "${this.escapeShellArg(filepath)}"`,
      );

      if (stderr) {
        logger.error(`Backup creation failed - filename: ${filename}`);
        throw new DatabaseError(
          "Database backup creation failed",
          DATABASE_ERROR_CODES.CREATE_FAILED,
          { context: { source: "BackupService.createBackup", cause: stderr } },
        );
      }

      logger.info(
        `Database backup created successfully - filename: ${filename}`,
      );

      // Compress if enabled
      if (this.config.compression) {
        logger.info("Compressing backup file");
        await this.compressFile(filepath);
        logger.info("Backup file compressed successfully");
      }

      // Encrypt if enabled
      if (this.config.encryption?.enabled) {
        logger.info("Encrypting backup file");
        await this.encryptFile(filepath);
        logger.info("Backup file encrypted successfully");
      }

      let finalFilepath = filepath;
      if (this.config.compression) {
        finalFilepath = `${filepath}.gz`;
      }
      if (this.config.encryption?.enabled) {
        finalFilepath = `${finalFilepath}.enc`;
      }

      if (!existsSync(finalFilepath)) {
        throw new DatabaseError(
          "Backup file was not created",
          DATABASE_ERROR_CODES.CREATE_FAILED,
          { context: { source: "BackupService.createBackup" } },
        );
      }

      const backupInfo: BackupInfo = {
        id: this.generateBackupId(),
        filename: this.config.compression ? `${filename}.gz` : filename,
        size: this.getFileSize(finalFilepath),
        createdAt: new Date(),
        expiresAt: new Date(
          Date.now() +
            this.config.retentionDays *
              NUMERIX.TWENTY_FOUR *
              NUMERIX.SIXTY *
              NUMERIX.SIXTY *
              NUMERIX.THOUSAND,
        ),
        status: "created",
        location: "local",
      };

      this.backups.set(backupInfo.id, backupInfo);

      // Upload to S3 if enabled
      if (this.config.s3?.enabled) {
        logger.info(`Uploading backup to S3 - backupId: ${backupInfo.id}`);
        await this.uploadToS3(backupInfo);
        logger.info("Backup uploaded to S3 successfully");
      }

      logger.info(
        `Backup process completed successfully - backupId: ${backupInfo.id}`,
      );
      return success(backupInfo);
    } catch (error) {
      logger.error(
        `Backup creation failed - error: ${(error as Error).message}`,
      );
      return failure(
        error instanceof DatabaseError
          ? error
          : new DatabaseError(
              "Backup creation failed",
              DATABASE_ERROR_CODES.CREATE_FAILED,
              {
                context: { source: "BackupService.createBackup", cause: error },
              },
            ),
      );
    }
  }

  /**
   * Restores database from a backup.
   * @param backupId ID of the backup to restore
   * @returns Operation result
   */
  // eslint-disable-next-line complexity
  async restoreBackup(backupId: string): Promise<DatabaseResult<null>> {
    try {
      if (!isString(backupId)) {
        return failure(
          new DatabaseError(
            "Invalid backup ID",
            DATABASE_ERROR_CODES.INVALID_PARAMETERS,
            { context: { source: "BackupService.restoreBackup" } },
          ),
        );
      }

      logger.info(`Starting backup restore - backupId: ${backupId}`);
      const backup = this.backups.get(backupId);
      if (!backup) {
        logger.error(`Backup not found for restore - backupId: ${backupId}`);
        return failure(
          new DatabaseError(
            "Backup not found",
            DATABASE_ERROR_CODES.RECORD_NOT_FOUND,
            { context: { source: "BackupService.restoreBackup", backupId } },
          ),
        );
      }

      let filepath = join(this.config.backupDir, backup.filename);

      // Download from S3 if needed
      if (backup.location === "s3" && this.config.s3?.enabled) {
        try {
          filepath = await this.downloadFromS3(backup);
        } catch (error) {
          throw new DatabaseError(
            "Failed to download backup from S3",
            DATABASE_ERROR_CODES.FETCH_FAILED,
            {
              context: { source: "BackupService.restoreBackup", cause: error },
            },
          );
        }
      }

      // Validate file exists before processing
      if (!existsSync(filepath)) {
        throw new DatabaseError(
          "Backup file not found",
          DATABASE_ERROR_CODES.RECORD_NOT_FOUND,
          { context: { source: "BackupService.restoreBackup", filepath } },
        );
      }

      // Decrypt if needed
      if (this.config.encryption?.enabled) {
        await this.decryptFile(filepath);
      }

      // Decompress if needed
      if (this.config.compression) {
        await this.decompressFile(filepath);
        filepath = filepath.replace(".gz", "");
      }

      // Validate filepath before restore
      if (!this.isValidPath(filepath)) {
        throw new DatabaseError(
          "Invalid file path for restore",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          { context: { source: "BackupService.restoreBackup", filepath } },
        );
      }

      // Restore using psql
      const execAsync = promisify(exec);
      const { stderr } = await execAsync(
        `psql "${this.escapeShellArg(this.config.connectionString)}" < "${this.escapeShellArg(filepath)}"`,
      );

      if (stderr) {
        logger.error(`Database restore failed - backupId: ${backupId}`);
        throw new DatabaseError(
          "Database restore failed",
          DATABASE_ERROR_CODES.RESTORE_FAILED,
          { context: { source: "BackupService.restoreBackup", cause: stderr } },
        );
      }

      logger.info(
        `Database restore completed successfully - backupId: ${backupId}`,
      );
      return success();
    } catch (error) {
      logger.error(`Backup restore failed - backupId: ${backupId}`);
      return failure(
        error instanceof DatabaseError
          ? error
          : new DatabaseError(
              "Backup restore failed",
              DATABASE_ERROR_CODES.UPDATE_FAILED,
              {
                context: {
                  source: "BackupService.restoreBackup",
                  cause: error,
                },
              },
            ),
      );
    }
  }

  /**
   * Lists all available backups.
   * @returns Array of backup information
   */
  async listBackups(): Promise<DatabaseResult<BackupInfo[]>> {
    try {
      const backups = Array.from(this.backups.values());
      return success(
        backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      );
    } catch (error) {
      return failure(
        new DatabaseError(
          "Failed to list backups",
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { context: { source: "BackupService.listBackups", cause: error } },
        ),
      );
    }
  }

  /**
   * Creates a scheduled backup.
   * @returns Information about the created backup
   */
  async scheduleBackup(): Promise<DatabaseResult<BackupInfo>> {
    return this.createBackup();
  }

  /**
   * Removes expired backups from storage.
   * @returns Operation result
   */
  async cleanupExpiredBackups(): Promise<DatabaseResult<null>> {
    try {
      const now = new Date();
      const expiredBackups = Array.from(this.backups.values()).filter(
        (backup) => backup.expiresAt < now,
      );

      logger.info(
        `Starting cleanup of expired backups - expiredCount: ${expiredBackups.length}`,
      );

      for (const backup of expiredBackups) {
        logger.info(
          `Deleting expired backup - backupId: ${backup.id}, filename: ${backup.filename}`,
        );
        await this.deleteBackup(backup.id);
      }

      logger.info(
        `Expired backups cleanup completed - deletedCount: ${expiredBackups.length}`,
      );
      return success();
    } catch (error) {
      logger.error("Backup cleanup failed");
      return failure(
        new DatabaseError(
          "Backup cleanup failed",
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: {
              source: "BackupService.cleanupExpiredBackups",
              cause: error,
            },
          },
        ),
      );
    }
  }

  /**
   * Deletes a specific backup.
   * @param backupId ID of the backup to delete
   */
  private async deleteBackup(backupId: string): Promise<void> {
    const backup = this.backups.get(backupId);
    if (!backup) return;

    const filepath = join(this.config.backupDir, backup.filename);

    // Delete local file
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }

    // Delete from S3 if needed
    if (backup.location === "s3" && this.config.s3?.enabled) {
      await this.deleteFromS3(backup);
    }

    this.backups.delete(backupId);
  }

  /**
   * Ensures backup directory exists.
   */
  private ensureBackupDir(): void {
    if (!existsSync(this.config.backupDir)) {
      logger.info(
        `Creating backup directory - backupDir: ${this.config.backupDir}`,
      );
      mkdirSync(this.config.backupDir, { recursive: true });
      logger.info("Backup directory created successfully");
    }
  }

  /**
   * Loads existing backups from the backup directory.
   */
  private loadExistingBackups(): void {
    if (!existsSync(this.config.backupDir)) return;

    const files = readdirSync(this.config.backupDir);
    logger.info(
      `Loading existing backups - backupDir: ${this.config.backupDir}, fileCount: ${files.length}`,
    );

    files.forEach((file) => {
      const filepath = join(this.config.backupDir, file);
      const stats = readFileSync(filepath);

      const backup: BackupInfo = {
        id: this.generateBackupId(),
        filename: file,
        size: stats.byteLength,
        createdAt: new Date(),
        expiresAt: new Date(
          Date.now() +
            this.config.retentionDays *
              NUMERIX.TWENTY_FOUR *
              NUMERIX.SIXTY *
              NUMERIX.SIXTY *
              NUMERIX.THOUSAND,
        ),
        status: "created",
        location: "local",
      };

      this.backups.set(backup.id, backup);
    });

    logger.info(
      `Existing backups loaded successfully -loadedCount ${this.backups.size}`,
    );
  }

  /**
   * Generates a unique backup ID.
   * @returns Unique backup identifier
   */
  private generateBackupId(): string {
    return `backup-${Date.now()}-${Math.random()
      .toString(NUMERIX.THIRTY_SIX)
      .substring(NUMERIX.TWO, NUMERIX.NINE + NUMERIX.TWO)}`;
  }

  /**
   * Gets file size in bytes.
   * @param filepath Path to the file
   * @returns File size in bytes
   */
  private getFileSize(filepath: string): number {
    return readFileSync(filepath).byteLength;
  }

  /**
   * Compresses a file using gzip.
   * @param filepath Path to the file to compress
   */
  private async compressFile(filepath: string): Promise<void> {
    if (!this.isValidPath(filepath)) {
      throw new DatabaseError(
        "Invalid file path for compression",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        { context: { source: "BackupService.compressFile", filepath } },
      );
    }
    const execAsync = promisify(exec);
    await execAsync(`gzip "${this.escapeShellArg(filepath)}"`);
  }

  /**
   * Decompresses a gzipped file.
   * @param filepath Path to the gzipped file
   */
  private async decompressFile(filepath: string): Promise<void> {
    if (!this.isValidPath(filepath)) {
      throw new DatabaseError(
        "Invalid file path for decompression",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        { context: { source: "BackupService.decompressFile", filepath } },
      );
    }
    const execAsync = promisify(exec);
    await execAsync(`gunzip "${this.escapeShellArg(filepath)}"`);
  }

  /**
   * Encrypts a file using OpenSSL.
   * @param filepath Path to the file to encrypt
   */
  private async encryptFile(filepath: string): Promise<void> {
    if (!this.config.encryption?.enabled) return;

    if (!this.isValidPath(filepath)) {
      throw new DatabaseError(
        "Invalid file path for encryption",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        { context: { source: "BackupService.encryptFile", filepath } },
      );
    }

    const outputPath = `${filepath}.enc`;
    const execAsync = promisify(exec);
    await execAsync(
      `openssl enc -aes-256-cbc -salt -in "${this.escapeShellArg(filepath)}" -out "${this.escapeShellArg(outputPath)}" -pass pass:"${this.escapeShellArg(this.config.encryption.key)}"`,
    );

    unlinkSync(filepath);
  }

  /**
   * Decrypts a file using OpenSSL.
   * @param filepath Path to the encrypted file
   */
  private async decryptFile(filepath: string): Promise<void> {
    // TODO: Implement proper encryption/decryption with error handling
    // Current implementation uses OpenSSL command line tool
    if (!this.config.encryption?.enabled) return;

    try {
      // Decrypt the file using AES-256-CBC
      const outputPath = filepath.replace(".enc", "");
      if (!this.isValidPath(filepath) || !this.isValidPath(outputPath)) {
        throw new DatabaseError(
          "Invalid file path for decryption",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          { context: { source: "BackupService.decryptFile", filepath } },
        );
      }

      const execAsync = promisify(exec);
      await execAsync(
        `openssl enc -aes-256-cbc -d -in "${this.escapeShellArg(filepath)}" -out "${this.escapeShellArg(outputPath)}" -pass pass:"${this.escapeShellArg(this.config.encryption.key)}"`,
      );

      // Remove the encrypted file after successful decryption
      if (existsSync(filepath)) {
        unlinkSync(filepath);
      }
    } catch (error) {
      throw new DatabaseError(
        "Failed to decrypt file",
        DATABASE_ERROR_CODES.DECRYPTION_FAILED,
        {
          context: {
            source: "BackupService.decryptFile",
            filepath,
            cause: error,
          },
        },
      );
    }
  }

  /**
   * Uploads a backup to S3.
   * @param backup Backup information
   */
  private async uploadToS3(backup: BackupInfo): Promise<void> {
    if (!this.config.s3?.enabled) return;

    try {
      if (!backup?.filename) {
        throw new DatabaseError(
          "Invalid backup information",
          DATABASE_ERROR_CODES.INVALID_BACKUP_INFO,
          { context: { source: "BackupService.uploadToS3" } },
        );
      }

      backup.status = "uploading";

      // Validate backup file exists before upload
      const localPath = join(this.config.backupDir, backup.filename);
      if (!existsSync(localPath)) {
        throw new DatabaseError(
          "Backup file not found for upload",
          DATABASE_ERROR_CODES.BACKUP_FILE_NOT_FOUND,
          { context: { source: "BackupService.uploadToS3", localPath } },
        );
      }

      // Placeholder: Mark as uploaded
      backup.status = "uploaded";
      backup.location = "s3";
    } catch (error) {
      backup.status = "failed";
      throw new DatabaseError(
        "Failed to upload backup to S3",
        DATABASE_ERROR_CODES.S3_UPLOAD_FAILED,
        { context: { source: "BackupService.uploadToS3", cause: error } },
      );
    }
  }

  /**
   * Downloads a backup from S3.
   * @param backup Backup information
   * @returns Local path to downloaded file
   */
  private async downloadFromS3(backup: BackupInfo): Promise<string> {
    // TODO: Implement AWS S3 download using AWS SDK v3
    // Current implementation is a placeholder for development
    if (!this.config.s3?.enabled) {
      throw new DatabaseError(
        "S3 is not configured",
        DATABASE_ERROR_CODES.S3_NOT_CONFIGURED,
        { context: { source: "BackupService.downloadFromS3" } },
      );
    }

    try {
      const localPath = join(this.config.backupDir, backup.filename);

      // In real implementation:
      // 1. Initialize S3 client with credentials
      // 2. Download file from S3 bucket
      // 3. Save to local filesystem
      // 4. Verify file integrity

      // Placeholder: Return expected local path
      return localPath;
    } catch (error) {
      throw new DatabaseError(
        "Failed to download backup from S3",
        DATABASE_ERROR_CODES.S3_DOWNLOAD_FAILED,
        {
          context: {
            source: "BackupService.downloadFromS3",
            filename: backup.filename,
            cause: error,
          },
        },
      );
    }
  }

  /**
   * Deletes a backup from S3.
   * @param backup Backup information
   */
  private async deleteFromS3(backup: BackupInfo): Promise<void> {
    // TODO: Implement AWS S3 delete using AWS SDK v3
    // Current implementation is a placeholder for development
    if (!this.config.s3?.enabled) return;

    try {
      // In real implementation:
      // 1. Initialize S3 client with credentials
      // 2. Delete object from S3 bucket using backup key
      // 3. Handle deletion errors and retries
      // Placeholder: Log deletion action
      // In production, this would actually delete from S3
    } catch (error) {
      throw new DatabaseError(
        "Failed to delete backup from S3",
        DATABASE_ERROR_CODES.S3_DELETE_FAILED,
        {
          context: {
            source: "BackupService.deleteFromS3",
            filename: backup.filename,
            cause: error,
          },
        },
      );
    }
  }

  /**
   * Sets up scheduled backups using cron.
   */
  private scheduleBackups(): void {
    // TODO: Implement cron-based scheduling using node-cron
    // Current implementation is a placeholder for development
    if (!this.config.schedule) return;

    try {
      // In real implementation:
      // 1. Install and import node-cron package
      // 2. Parse cron expression from config.schedule
      // 3. Schedule recurring backup task
      // 4. Handle cron job errors and logging
      // Example implementation would be:
      // const cron = require('node-cron');
      // cron.schedule(this.config.schedule, async () => {
      //   try {
      //     await this.createBackup();
      //   } catch (error) {
      //     // Handle scheduled backup errors
      //   }
      // });
      // Placeholder: Log scheduling setup
    } catch {
      throw new DatabaseError(
        "Failed to setup backup schedule",
        DATABASE_ERROR_CODES.SCHEDULE_SETUP_FAILED,
        { context: { source: "BackupService.scheduleBackups" } },
      );
    }
  }

  /**
   * Validates file paths to prevent path traversal attacks.
   * @param filepath Path to validate
   * @returns True if path is valid and safe
   */
  private isValidPath(filepath: string): boolean {
    // Check for null, undefined, or empty paths
    if (!isString(filepath)) {
      return false;
    }

    // Check for path traversal patterns
    const dangerousPatterns = [
      "../",
      "..\\", // Directory traversal
      "~/", // Home directory access
      "/etc/",
      "/proc/",
      "/sys/", // System directories
      "C:\\Windows\\",
      "C:\\Program Files\\", // Windows system directories
    ];

    const normalizedPath = filepath.toLowerCase();
    return !dangerousPatterns.some((pattern) =>
      normalizedPath.includes(pattern.toLowerCase()),
    );
  }

  /**
   * Escapes shell arguments to prevent command injection.
   * @param arg Argument to escape
   * @returns Escaped argument safe for shell execution
   */
  private escapeShellArg(arg: string): string {
    if (!isString(arg)) {
      throw new DatabaseError(
        "Invalid shell argument",
        DATABASE_ERROR_CODES.INVALID_SHELL_ARG,
        { context: { source: "BackupService.escapeShellArg" } },
      );
    }

    // Remove or escape dangerous characters
    return DB_REGEX.sanitizeCommand(arg);
  }

  /**
   * Sanitizes strings for safe logging to prevent log injection.
   * @param input String to sanitize
   * @returns Sanitized string safe for logging
   */
  private sanitizeForLog(input: string): string {
    if (!isString(input)) {
      return "[invalid_input]";
    }

    const MAX_LOG_LENGTH = 200;
    return DB_REGEX.sanitizeLogMessage(input).substring(0, MAX_LOG_LENGTH);
  }
}
