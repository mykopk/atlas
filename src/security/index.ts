/**
 * @module
 * Security module.
 *
 * Provides NestJS pipes for input sanitization and validation.
 * Combines HTML stripping with Zod schema validation to ensure
 * safe, well-formed request data.
 *
 * Sub-modules:
 * - {@link "./sanitizers/html.sanitizer"} – SanitizeHtmlPipe for stripping unsafe HTML
 * - {@link "./serializers/DataValidation"} – DataValidationPipe for Zod validation
 */

export * from "./sanitizers/html.sanitizer";
export * from "./serializers/DataValidation";
