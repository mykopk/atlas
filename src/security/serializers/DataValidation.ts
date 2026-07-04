import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { ZodType } from "zod";
import { SanitizeHtmlPipe } from "../sanitizers/html.sanitizer";

/**
 * A NestJS pipe that chains input sanitization and Zod validation.
 *
 * @description
 * Incoming data is first passed through {@link SanitizeHtmlPipe} to strip
 * unsafe HTML from all string values. The sanitized result is then parsed
 * against the provided Zod schema. If validation fails, a
 * `BadRequestException` is thrown with the Zod error message.
 *
 * Typical usage: apply to a controller's `@Body()` or `@Query()` parameter
 * to guarantee both safety and structural validity of external input.
 *
 * @example
 * ```typescript
 * // Schema definition
 * const createUserSchema = z.object({
 *   name: z.string().min(1),
 *   email: z.string().email(),
 * });
 *
 * // Controller
 * \@Post()
 * async create(
 *   \@Body(new DataValidationPipe(createUserSchema)) dto: z.infer<typeof createUserSchema>,
 * ) { … }
 * ```
 */
@Injectable()
export class DataValidationPipe implements PipeTransform {
  private readonly sanitizeHtmlPipe = new SanitizeHtmlPipe();

  /**
   * Create a DataValidationPipe.
   *
   * @param schema - A Zod schema used to validate sanitized input data
   */
  constructor(private schema: ZodType) {}

  /**
   * Sanitize and validate incoming data.
   *
   * @description
   * The pipeline is:
   * 1. All string values are sanitized (HTML tags stripped).
   * 2. The sanitized data is parsed against the Zod schema supplied in the constructor.
   * 3. On success, the parsed (and potentially transformed) data is returned.
   * 4. On failure, a `BadRequestException` is thrown.
   *
   * @param value - The raw incoming value (body, query, param, etc.)
   * @returns The sanitized and Zod-validated data
   * @throws {BadRequestException} When Zod schema parsing fails
   *
   * @example
   * ```typescript
   * const pipe = new DataValidationPipe(z.object({ age: z.number() }));
   * pipe.transform({ age: "25" });
   * // → BadRequestException: "Validation failed: Expected number, received string"
   * ```
   */
  transform(value: unknown): unknown {
    const sanitizedValue = this.sanitizeHtmlPipe.transform(value);

    try {
      return this.schema.parse(sanitizedValue);
    } catch (error) {
      if (error instanceof Error) {
        throw new BadRequestException(`Validation failed: ${error.message}`);
      }
      throw new BadRequestException(`Invalid request data.`);
    }
  }
}
