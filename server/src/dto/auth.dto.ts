import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ type: String, example: "eran.amir@gostork.com" })
  email!: string;

  @ApiProperty({ type: String, example: "GoStork2026!" })
  password!: string;
}

export class LoginResponseDto {
  @ApiProperty({ type: String, example: "uuid-string" })
  id!: string;

  @ApiProperty({ type: String, example: "eran.amir@gostork.com" })
  email!: string;

  @ApiPropertyOptional({ type: String, example: "Eran Amir", nullable: true })
  name?: string | null;

  @ApiProperty({ type: [String], example: ["GOSTORK_ADMIN"], description: "Array of roles" })
  roles!: string[];

  @ApiPropertyOptional({ type: String, example: "uuid-string", nullable: true })
  providerId?: string | null;

  @ApiPropertyOptional({ type: String, description: "JWT token for mobile/API clients" })
  token?: string;

  @ApiPropertyOptional({ type: Object, description: "Provider with nested services (if provider role)" })
  provider?: any;
}

export class LogoutResponseDto {
  @ApiProperty({ type: String, example: "Logged out" })
  message!: string;
}

export class ErrorResponseDto {
  @ApiProperty({ type: String, example: "Unauthorized" })
  message!: string;
}
