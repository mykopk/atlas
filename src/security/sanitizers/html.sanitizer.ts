import { PipeTransform, Injectable } from "@nestjs/common";
import sanitizeHtml from "sanitize-html";
import { isString, isObject } from "@utils/typeGuards";

/**
 * A NestJS pipe that recursively sanitizes input data to remove any potentially unsafe HTML.
 *
 * @description
 * This pipe can handle strings, arrays, and objects. All string values within
 * the provided data are sanitized using the `sanitize-html` library with a
 * strict policy: all tags and attributes are stripped, and only safe URL
 * schemes (`http`, `https`, `mailto`) are allowed.
 *
 * Use as a global pipe, a controller-scoped pipe, or on individual route
 * handlers to ensure no HTML/script content reaches your application logic.
 *
 * @example
 * ```typescript
 * // Controller-scoped
 * \@UsePipes(new SanitizeHtmlPipe())
 * \@Post()
 * async create(@Body() dto: CreateUserDto) { … }
 * ```
 */
@Injectable()
export class SanitizeHtmlPipe implements PipeTransform {
  /**
   * Sanitize a value recursively.
   *
   * @description
   * - Strings are sanitized via `sanitize-html` (all tags stripped).
   * - Arrays are mapped element-by-element with recursive sanitization.
   * - Plain objects have every enumerable property sanitized recursively.
   * - Other primitive types (number, boolean, null, undefined) pass through unchanged.
   *
   * @typeParam T - The incoming value type
   * @param value - The value to sanitize
   * @returns The sanitized value with the same structure
   *
   * @example
   * ```typescript
   * const pipe = new SanitizeHtmlPipe();
   * pipe.transform('<script>alert("xss")</script>');
   * // → ''
   *
   * pipe.transform({ name: '<b>Alice</b>' });
   * // → { name: 'Alice' }
   * ```
   */
  transform<T>(value: T): string | Record<string, unknown> | unknown[] {
    if (isString(value)) {
      return this.sanitizeString(value);
    }

    if (Array.isArray(value)) {
      return value.map((v) => this.transform(v));
    }

    if (isObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.transform(val);
      }
      return result;
    }

    return value as unknown[];
  }

  /**
   * Sanitize a single string by stripping all HTML tags and attributes.
   *
   * @description
   * Uses `sanitize-html` with an empty allowlist so every tag and attribute
   * is removed. Only `http`, `https`, and `mailto` URL schemes are preserved
   * (the scheme text itself is kept, but the link is not rendered as HTML).
   *
   * @param str - The raw string potentially containing HTML
   * @returns The sanitized string with all HTML removed
   * @private
   */
  private sanitizeString(str: string): string {
    return sanitizeHtml(str, {
      allowedTags: [],
      allowedAttributes: {},
      allowedSchemes: ["http", "https", "mailto"],
    });
  }
}
