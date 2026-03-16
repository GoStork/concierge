import { ExceptionFilter, Catch, NotFoundException, ArgumentsHost } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

@Catch(NotFoundException)
export class SpaFallbackFilter implements ExceptionFilter {
  catch(exception: NotFoundException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const next = ctx.getNext<NextFunction>();

    if (request.path.startsWith("/api") || request.path.startsWith("/docs")) {
      response.status(404).json({
        message: exception.message,
        error: "Not Found",
        statusCode: 404,
      });
    } else {
      next();
    }
  }
}
