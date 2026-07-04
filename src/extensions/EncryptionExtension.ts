import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import {
  type DatabaseAdapterType,
  type DatabaseResult,
  type QueryOptions,
  type PaginatedResult,
  type Transaction,
  type Filter,
  type DatabaseHealthStatus,
  ENCRYPTION_DEFAULTS,
} from "@myko.pk/types/db";
import { isString, isObject } from "@utils/typeGuards";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";

/**
 * ENCRYPTION ADAPTER — Field-Level Encryption Layer
 *
 * Encryption extension that automatically encrypts/decrypts specified fields.
 * Second layer in the adapter chain (after the base adapter).
 *
 * **Adapter Chain Position:**
 * ReadReplica → Audit → Cache → SoftDelete → **Encryption** → Base Adapter
 *
 * **What this adapter does:**
 * 1. Receives operations from SoftDeleteAdapter (or the next layer)
 * 2. Encrypts sensitive fields before write operations (create, update)
 * 3. Delegates to the base adapter with encrypted data
 * 4. Decrypts fields in response data after read operations
 * 5. Passes results back up the chain
 *
 * **Called by:** SoftDeleteAdapter (or CachingAdapter if no soft delete)
 * **Calls:** Base adapter methods (DrizzleAdapter, SupabaseAdapter, etc.)
 * **Wraps:** Base database adapter with transparent encryption
 *
 * **Encryption Flow:**
 * - **Writes:** Plain data → Encrypt fields → Store encrypted → Return decrypted
 * - **Reads:** Retrieve encrypted → Decrypt fields → Return plain data
 *
 * @example
 * ### Configuration
 * ```typescript
 * encryption: {
 *   enabled: true,
 *   key: process.env.ENCRYPTION_KEY,
 *   fields: {
 *     [Tables.USERS]: ['ssn', 'taxId'],
 *     [Tables.PAYMENTS]: ['cardNumber', 'cvv']
 *   }
 * }
 * ```
 *
 * @example
 * ### Transparent Usage
 * ```typescript
 * // Application code — encryption is transparent
 * await db.create(Tables.USERS, {
 *   name: 'John Doe',
 *   ssn: '123-45-6789'  // Automatically encrypted before storage
 * });
 *
 * // Retrieved data is automatically decrypted
 * const user = await db.get(Tables.USERS, userId);
 * console.log(user.value.ssn); // '123-45-6789' (decrypted)
 * ```
 */

export class EncryptionAdapter implements DatabaseAdapterType {
  // Using shared logger instance from @myko/logger

  /**
   * Creates a new EncryptionAdapter instance.
   *
   * @param baseAdapter - The underlying database adapter to wrap
   * @param config - Encryption configuration with key and per-table field mappings
   */
  constructor(
    public baseAdapter: DatabaseAdapterType,
    private config: {
      enabled: boolean;
      key: string;
      fields: Record<string, string[]>;
      algorithm?: string;
    },
  ) {}

  /**
   * Initializes the underlying database adapter.
   *
   * @returns Promise resolving to the initialization result
   */
  async initialize(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.initialize();
  }

  /**
   * Establishes the database connection through the base adapter.
   *
   * @returns Promise that resolves when connected
   */
  async connect(): Promise<void> {
    return this.baseAdapter.connect();
  }

  /**
   * Closes the database connection through the base adapter.
   *
   * @returns Promise that resolves when disconnected
   */
  async disconnect(): Promise<void> {
    return this.baseAdapter.disconnect();
  }

  /**
   * Closes the database adapter and releases resources.
   *
   * @returns Promise resolving to the close result
   */
  async close(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.close();
  }

  /**
   * Returns the underlying database client for direct access.
   *
   * @returns The database client instance
   */
  getClient<T extends object = object>(): T {
    return this.baseAdapter.getClient<T>();
  }

  /**
   * Executes raw SQL query through the base adapter.
   * Raw queries bypass encryption — use CRUD methods for automatic field encryption.
   *
   * @param sql - SQL query string
   * @param params - Query parameters
   * @returns Query results
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    return this.baseAdapter.query<TResult, TParams>(sql, params);
  }

  /**
   * Registers a table schema with the base adapter.
   *
   * @param name - Table name
   * @param table - Table schema definition
   * @param idColumn - Primary key column name
   */
  registerTable<T, U>(name: string, table: T, idColumn?: U): void {
    this.baseAdapter.registerTable(name, table, idColumn);
  }

  /**
   * Finds a record by its primary key with automatic field decryption.
   * Encrypted fields are transparently decrypted in the response.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns The found record with decrypted fields, or null
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    const result = await this.baseAdapter.findById<T>(table, id);
    if (result.success && result.value) {
      result.value = this.decryptFields(table, result.value);
    }
    return result;
  }

  /**
   * Finds multiple records with automatic field decryption on each result.
   *
   * @param table - Table name
   * @param options - Query options including filters, pagination, and sorting
   * @returns Paginated results with decrypted fields
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    const result = await this.baseAdapter.findMany<T>(table, options);
    if (result.success && result.value) {
      result.value.data = result.value.data.map((item) =>
        this.decryptFields(table, item),
      );
    }
    return result;
  }

  /**
   * Creates a new record with automatic field encryption.
   * Encrypts configured fields before delegating to the base adapter,
   * then decrypts the response so callers receive plain data.
   *
   * @param table - Table name
   * @param data - Record data (plaintext fields will be encrypted)
   * @returns The created record with decrypted fields
   * @throws {DatabaseError} If encryption fails — intentional fail-closed behavior for compliance
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    // Encryption is critical for compliance - fail if encryption fails
    // AuditAdapter (outer layer) will catch and log the failure
    const encryptedData = this.encryptFields(table, data);
    const result = await this.baseAdapter.create<T>(table, encryptedData);
    if (result.success && result.value) {
      result.value = this.decryptFields(table, result.value);
    }
    return result;
  }

  /**
   * Updates a record with automatic field encryption.
   * Encrypts the specified partial fields before delegating to the base adapter,
   * then decrypts the response.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @param data - Partial record data (plaintext fields will be encrypted)
   * @returns The updated record with decrypted fields
   * @throws {DatabaseError} If encryption fails — intentional fail-closed behavior for compliance
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    // Encryption is critical for compliance - fail if encryption fails
    // AuditAdapter (outer layer) will catch and log the failure
    const encryptedData = this.encryptFields(table, data);
    const result = await this.baseAdapter.update<T>(table, id, encryptedData);
    if (result.success && result.value) {
      result.value = this.decryptFields(table, result.value);
    }
    return result;
  }

  /**
   * Deletes a record through the base adapter. No encryption/decryption needed.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns Deletion result
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    return this.baseAdapter.delete(table, id);
  }

  /**
   * Executes operations within a database transaction through the base adapter.
   * Encryption within transactions is handled per-operation.
   *
   * @param callback - Async callback receiving the transaction object
   * @returns Promise resolving to the transaction result
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.transaction(callback);
  }

  /**
   * Checks whether a record exists by its primary key through the base adapter.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns True if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    return this.baseAdapter.exists(table, id);
  }

  /**
   * Counts records matching the optional filter through the base adapter.
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Record count
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    return this.baseAdapter.count<T>(table, filter);
  }

  /**
   * Performs a health check against the underlying database adapter.
   *
   * @returns Health status including connectivity and latency information
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.baseAdapter.healthCheck();
  }

  /**
   * Encrypts all configured fields for the given table on the provided data object.
   * Skips processing if encryption is disabled, data is not an object, or no fields are configured.
   *
   * @param table - Table name to look up configured fields
   * @param data - Source data object with plaintext field values
   * @returns A new data object with encrypted field values
   */
  private encryptFields<T extends object>(table: string, data: T): T {
    if (!this.shouldProcessFields(data, table)) return data;

    const fieldsToEncrypt = this.config.fields[table];
    const result = { ...data } as T;

    for (const field of fieldsToEncrypt) {
      this.encryptSingleField(result, field);
    }

    return result as T;
  }

  /**
   * Determines whether field encryption/decryption should be applied.
   * Returns true only when encryption is enabled, data is an object, and the table has configured fields.
   *
   * @param data - Data object to check
   * @param table - Table name to check for field configuration
   * @returns True if processing should proceed
   */
  private shouldProcessFields<T>(data: T, table: string): boolean {
    return (
      this.config.enabled &&
      isObject(data) &&
      Boolean(this.config.fields[table])
    );
  }

  /**
   * Encrypts a single field on the result object in-place.
   * Skips fields with falsy values.
   *
   * @param result - The data object to mutate
   * @param field - The field name to encrypt
   */
  private encryptSingleField<T extends object>(result: T, field: string): void {
    if (result[field as keyof T]) {
      result[field as keyof T] = this.encrypt(
        String(result[field as keyof T]),
      ) as T[keyof T];
    }
  }

  /**
   * Decrypts all configured fields for the given table on the provided data object.
   * Skips processing if encryption is disabled, data is not an object, or no fields are configured.
   *
   * @param table - Table name to look up configured fields
   * @param data - Source data object with encrypted field values
   * @returns A new data object with decrypted field values
   */
  private decryptFields<T extends object>(table: string, data: T): T {
    if (!this.shouldProcessFields(data, table)) return data;

    const fieldsToDecrypt = this.config.fields[table];
    const result = { ...data } as T;

    for (const field of fieldsToDecrypt) {
      this.decryptSingleField(result, field);
    }

    return result as T;
  }

  /**
   * Decrypts a single field on the result object in-place.
   * Handles backwards compatibility with unencrypted data by checking
   * whether the value matches the encrypted format before attempting decryption.
   * Logs a warning and returns the value as-is if decryption fails.
   *
   * @param result - The data object to mutate
   * @param field - The field name to decrypt
   */
  private decryptSingleField<T extends object>(result: T, field: string): void {
    if (result[field as keyof T]) {
      const fieldValue = String(result[field as keyof T]);
      // Check if the field value is encrypted (contains colons)
      // If not encrypted, return as-is (backwards compatibility with old data)
      if (this.isEncryptedValue(fieldValue)) {
        try {
          result[field as keyof T] = this.decrypt(fieldValue) as T[keyof T];
        } catch (error) {
          // Decryption failed - might be corrupted data or wrong key
          console.warn(
            `Failed to decrypt field ${field}, returning as-is:`,
            (error as Error).message,
          );
        }
      }
    }
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * Produces an encrypted string in the format `iv:authTag:ciphertext`.
   *
   * @param text - Plaintext string to encrypt
   * @returns Encrypted string in `iv:authTag:ciphertext` format
   * @throws {DatabaseError} If the input is not a string or the encryption key is missing
   */
  private encrypt(text: string): string {
    this.validateEncryptionInput(text);

    const { iv, cipher } = this.createCipher();
    const encrypted = this.performEncryption(cipher, text);
    const authTag =
      (cipher as { getAuthTag?: () => Buffer }).getAuthTag?.() ??
      Buffer.alloc(0);

    return iv.toString("hex") + ":" + authTag.toString("hex") + ":" + encrypted;
  }

  /**
   * Validates that the encryption input is a non-empty string and the encryption key is configured.
   *
   * @param text - The text to validate
   * @throws {DatabaseError} INVALID_PARAMETERS - If text is not a string
   * @throws {DatabaseError} CONFIG_REQUIRED - If encryption key is not set
   */
  private validateEncryptionInput(text: string): void {
    if (!isString(text)) {
      throw new DatabaseError(
        "Invalid text for encryption",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "validateEncryptionInput" },
          cause: new Error("Invalid text for encryption"),
        },
      );
    }
    if (!this.config.key) {
      throw new DatabaseError(
        "Encryption key is required",
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
        {
          context: { source: "validateEncryptionInput" },
          cause: new Error("Encryption key is required"),
        },
      );
    }
  }

  /**
   * Creates a cipher instance for AES-256-GCM encryption with a random initialization vector.
   *
   * @returns An object containing the IV buffer and the cipher instance
   * @throws {DatabaseError} If the key length is not exactly 32 bytes
   */
  private createCipher(): {
    iv: Buffer;
    cipher: ReturnType<typeof createCipheriv>;
  } {
    const algorithm = this.config.algorithm ?? ENCRYPTION_DEFAULTS.ALGORITHM;
    const key = this.getKeyBuffer();
    const iv = randomBytes(ENCRYPTION_DEFAULTS.IV_LENGTH);
    const cipher = createCipheriv(algorithm, key, iv);
    return { iv, cipher };
  }

  /**
   * Performs the actual AES encryption on the given text using the provided cipher.
   *
   * @param cipher - The cipher instance to use for encryption
   * @param text - The plaintext string to encrypt
   * @returns Hex-encoded encrypted string
   */
  private performEncryption(
    cipher: ReturnType<typeof createCipheriv>,
    text: string,
  ): string {
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return encrypted;
  }

  /**
   * Decrypts an encrypted string in `iv:authTag:ciphertext` format using AES-256-GCM.
   *
   * @param encryptedText - The encrypted string to decrypt
   * @returns Decrypted plaintext string
   * @throws {DatabaseError} If the input format is invalid or the key is missing
   */
  private decrypt(encryptedText: string): string {
    this.validateDecryptionInput(encryptedText);

    const parts = this.parseEncryptedText(encryptedText);
    const { iv, authTag, encrypted } = this.extractDecryptionParts(parts);
    const decipher = this.createDecipher(iv, authTag);

    return this.performDecryption(decipher, encrypted);
  }

  /**
   * Validates that the decryption input is a non-empty string and the encryption key is configured.
   *
   * @param encryptedText - The encrypted text to validate
   * @throws {DatabaseError} INVALID_PARAMETERS - If text is not a string
   * @throws {DatabaseError} CONFIG_REQUIRED - If encryption key is not set
   */
  private validateDecryptionInput(encryptedText: string): void {
    if (!isString(encryptedText)) {
      throw new DatabaseError(
        "Invalid encrypted text for decryption",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "validateDecryptionInput" },
          cause: new Error("Invalid encrypted text for decryption"),
        },
      );
    }
    if (!this.config.key) {
      throw new DatabaseError(
        "Encryption key is required",
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
        {
          context: { source: "validateDecryptionInput" },
          cause: new Error("Encryption key is required"),
        },
      );
    }
  }

  /**
   * Parses an encrypted text string by splitting on colons and validates the part count.
   *
   * @param encryptedText - The encrypted string in `iv:authTag:ciphertext` format
   * @returns Array of string parts
   * @throws {DatabaseError} If the part count doesn't match the expected encrypted parts count
   */
  private parseEncryptedText(encryptedText: string): string[] {
    const parts = encryptedText.split(":");
    if (parts.length !== ENCRYPTION_DEFAULTS.ENCRYPTED_PARTS_COUNT) {
      throw new DatabaseError(
        "Invalid encrypted text format",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "parseEncryptedText" },
          cause: new Error("Invalid encrypted text format"),
        },
      );
    }
    return parts;
  }

  /**
   * Extracts the IV, auth tag, and encrypted payload from parsed encrypted text parts.
   *
   * @param parts - String array from parsing encrypted text (iv, authTag, encrypted)
   * @returns Object containing the IV buffer, auth tag buffer, and encrypted hex string
   */
  private extractDecryptionParts(parts: string[]): {
    iv: Buffer;
    authTag: Buffer;
    encrypted: string;
  } {
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    return { iv, authTag, encrypted };
  }

  /**
   * Creates a decipher instance for AES-256-GCM decryption with the given IV and auth tag.
   *
   * @param iv - Initialization vector buffer
   * @param authTag - Authentication tag buffer
   * @returns The decipher instance ready for decryption
   * @throws {DatabaseError} If the key length is not exactly 32 bytes
   */
  private createDecipher(
    iv: Buffer,
    authTag: Buffer,
  ): ReturnType<typeof createDecipheriv> {
    const algorithm = this.config.algorithm ?? ENCRYPTION_DEFAULTS.ALGORITHM;
    const key = this.getKeyBuffer();
    const decipher = createDecipheriv(algorithm, key, iv);

    if (authTag.length > 0) {
      (decipher as { setAuthTag?: (tag: Buffer) => void }).setAuthTag?.(
        authTag,
      );
    }

    return decipher;
  }

  /**
   * Performs the actual AES decryption using the provided decipher.
   *
   * @param decipher - The decipher instance to use for decryption
   * @param encrypted - The hex-encoded encrypted string
   * @returns Decrypted plaintext string
   */
  private performDecryption(
    decipher: ReturnType<typeof createDecipheriv>,
    encrypted: string,
  ): string {
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * Checks whether a string value appears to be encrypted by verifying the `iv:authTag:ciphertext` format.
   * Used for backwards compatibility to distinguish encrypted fields from legacy plaintext data.
   *
   * @param value - The field value to check
   * @returns True if the value matches the encrypted format (3 colon-separated hex parts)
   */
  private isEncryptedValue(value: string): boolean {
    // Encrypted values have format: iv:authTag:encrypted (3 parts separated by colons)
    const parts = value.split(":");
    return parts.length === ENCRYPTION_DEFAULTS.ENCRYPTED_PARTS_COUNT;
  }

  /**
   * Derives the encryption key buffer from the configured key string.
   * Validates that the key is exactly 32 bytes for AES-256-GCM.
   *
   * @returns Buffer containing the 32-byte encryption key
   * @throws {DatabaseError} CONFIG_REQUIRED - If the key is not exactly 32 bytes
   */
  private getKeyBuffer(): Buffer {
    // AES-256-GCM requires 32-byte key
    const AES_256_KEY_LENGTH = 32;
    const keyBuffer = Buffer.from(this.config.key, "utf8");

    if (keyBuffer.length !== AES_256_KEY_LENGTH) {
      throw new DatabaseError(
        `Encryption key must be exactly ${AES_256_KEY_LENGTH} bytes for AES-256, got ${keyBuffer.length}`,
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
        {
          context: { source: "getKeyBuffer" },
          cause: new Error("Invalid key length"),
        },
      );
    }

    return keyBuffer;
  }
}
