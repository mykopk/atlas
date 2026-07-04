/**
 * @module backup
 * @description Provides database backup and restore functionality including
 * compression, encryption (AES-256-CBC), S3 cloud storage upload/download,
 * scheduled backups via cron, configurable retention policies, and automatic
 * cleanup of expired backups.
 */
export { BackupService } from "./BackupService";
