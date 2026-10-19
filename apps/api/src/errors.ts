/** An error with an HTTP status and a short machine code; the error handler turns it into JSON. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
