import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateUserDto {
  @ApiProperty({ type: String, example: "user@example.com" })
  email!: string;

  @ApiProperty({ type: String, example: "SecurePass123!", minLength: 6 })
  password!: string;

  @ApiPropertyOptional({ type: String, example: "Jane Doe" })
  name?: string;

  @ApiPropertyOptional({ type: String, example: "https://example.com/photo.jpg", nullable: true })
  photoUrl?: string | null;

  @ApiPropertyOptional({ type: [String], example: ["PARENT"], description: "Array of roles" })
  roles?: string[];

  @ApiPropertyOptional({ type: String, example: "uuid-string", nullable: true })
  providerId?: string | null;

  @ApiPropertyOptional({ type: String, example: "+1234567890" })
  mobileNumber?: string;

  @ApiPropertyOptional({ type: Boolean, example: true, description: "If true, user has access to all provider locations" })
  allLocations?: boolean;

  @ApiPropertyOptional({ type: [String], example: ["uuid-1", "uuid-2"], description: "Array of location IDs to assign" })
  locationIds?: string[];
}

export class UserResponseDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  id!: string;

  @ApiProperty({ type: String, example: "user@example.com" })
  email!: string;

  @ApiPropertyOptional({ type: String, example: "Jane Doe", nullable: true })
  name?: string | null;

  @ApiPropertyOptional({ type: String, example: "https://example.com/photo.jpg", nullable: true })
  photoUrl?: string | null;

  @ApiProperty({ type: [String], example: ["PARENT"], description: "Array of roles" })
  roles!: string[];

  @ApiPropertyOptional({ type: String, example: "uuid-string", nullable: true })
  providerId?: string | null;

  @ApiPropertyOptional({ type: String, example: "+1234567890", nullable: true })
  mobileNumber?: string | null;

  @ApiPropertyOptional({ type: Boolean, example: true })
  allLocations?: boolean;

  @ApiPropertyOptional({ type: Object, description: "Provider with nested services (if provider role)" })
  provider?: any;

  @ApiPropertyOptional({ type: [Object], description: "Assigned locations" })
  assignedLocations?: any[];
}
