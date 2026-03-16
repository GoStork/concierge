import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateProviderDto {
  @ApiProperty({ type: String, example: "Hatch" })
  name!: string;
}

export class UpdateProviderDto {
  @ApiPropertyOptional({ type: String, example: "Hatch Fertility" })
  name?: string;
}

export class ProviderTypeDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  id!: string;

  @ApiProperty({ type: String, example: "IVF Clinic" })
  name!: string;
}

export class ProviderServiceDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  id!: string;

  @ApiProperty({ type: String, example: "uuid-string" })
  providerId!: string;

  @ApiProperty({ type: String, example: "uuid-string" })
  providerTypeId!: string;

  @ApiProperty({ type: String, example: "APPROVED", enum: ["NEW", "IN_PROGRESS", "APPROVED", "DECLINED"] })
  status!: string;

  @ApiPropertyOptional({ type: () => ProviderTypeDto })
  providerType?: ProviderTypeDto;
}

export class ProviderLocationDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  id!: string;

  @ApiProperty({ type: String, example: "uuid-string" })
  providerId!: string;

  @ApiProperty({ type: String, example: "123 Main St" })
  address!: string;

  @ApiProperty({ type: String, example: "Los Angeles" })
  city!: string;

  @ApiProperty({ type: String, example: "CA" })
  state!: string;

  @ApiProperty({ type: String, example: "90001" })
  zip!: string;
}

export class ProviderResponseDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  id!: string;

  @ApiProperty({ type: String, example: "Hatch" })
  name!: string;

  @ApiProperty({ type: String })
  createdAt!: Date;

  @ApiProperty({ type: String })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: () => [ProviderServiceDto] })
  services?: ProviderServiceDto[];

  @ApiPropertyOptional({ type: () => [ProviderLocationDto] })
  locations?: ProviderLocationDto[];
}

export class CreateProviderTypeDto {
  @ApiProperty({ type: String, example: "IVF Clinic" })
  name!: string;
}

export class CreateProviderServiceDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  providerTypeId!: string;

  @ApiPropertyOptional({ type: String, example: "NEW", enum: ["NEW", "IN_PROGRESS", "APPROVED", "DECLINED"], default: "NEW" })
  status?: string;
}

export class UpdateProviderServiceDto {
  @ApiPropertyOptional({ type: String, example: "uuid-string" })
  providerTypeId?: string;

  @ApiPropertyOptional({ type: String, example: "APPROVED", enum: ["NEW", "IN_PROGRESS", "APPROVED", "DECLINED"] })
  status?: string;
}

export class CreateProviderLocationDto {
  @ApiProperty({ type: String, example: "123 Main St" })
  address!: string;

  @ApiProperty({ type: String, example: "Los Angeles" })
  city!: string;

  @ApiProperty({ type: String, example: "CA" })
  state!: string;

  @ApiProperty({ type: String, example: "90001" })
  zip!: string;
}

export class UpdateProviderLocationDto {
  @ApiPropertyOptional({ type: String, example: "456 Oak Ave" })
  address?: string;

  @ApiPropertyOptional({ type: String, example: "San Francisco" })
  city?: string;

  @ApiPropertyOptional({ type: String, example: "CA" })
  state?: string;

  @ApiPropertyOptional({ type: String, example: "94102" })
  zip?: string;
}
