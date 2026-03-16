import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  Inject,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody } from "@nestjs/swagger";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertProviderTypeSchema } from "@shared/schema";
import { z } from "zod";
import { CreateProviderTypeDto, ProviderTypeDto } from "../../dto/provider.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";

@ApiTags("Provider Types")
@Controller("api/provider-types")
export class ProviderTypesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "List all provider types" })
  @ApiResponse({ status: 200, description: "List of provider types", type: [ProviderTypeDto] })
  async list() {
    return this.prisma.providerType.findMany({
      orderBy: { name: "asc" },
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a new provider type (GOSTORK_ADMIN only)" })
  @ApiBody({ type: CreateProviderTypeDto })
  @ApiResponse({ status: 201, description: "Provider type created", type: ProviderTypeDto })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 401, description: "Unauthorized", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async create(@Body() body: any, @Req() req: Request) {
    if (!(req.user as any).roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderTypeSchema.parse(body);
      return await this.prisma.providerType.create({ data: input });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }
}
