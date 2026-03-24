import { prisma } from "./db";
import type {
  User, Provider, ProviderService, ProviderLocation, ProviderType,
  InsertUser, InsertProvider, InsertProviderService, InsertProviderLocation,
  UpdateProviderRequest, UpdateProviderServiceRequest, UpdateProviderLocationRequest,
  UserWithProvider, ProviderWithRelations,
  InsertProviderType,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserWithProvider(id: string): Promise<UserWithProvider | null>;
  createUser(user: InsertUser): Promise<User>;

  getProvider(id: string): Promise<ProviderWithRelations | null>;
  getAllProviders(): Promise<ProviderWithRelations[]>;
  createProvider(provider: InsertProvider): Promise<Provider>;
  updateProvider(id: string, provider: UpdateProviderRequest): Promise<Provider>;

  getProviderType(id: string): Promise<ProviderType | null>;
  getAllProviderTypes(): Promise<ProviderType[]>;
  createProviderType(providerType: InsertProviderType): Promise<ProviderType>;

  getProviderServices(providerId: string): Promise<(ProviderService & { providerType: ProviderType })[]>;
  createProviderService(service: { providerId: string; providerTypeId: string; status?: string }): Promise<ProviderService>;
  updateProviderService(id: string, updates: UpdateProviderServiceRequest): Promise<ProviderService>;

  getProviderLocations(providerId: string): Promise<ProviderLocation[]>;
  createProviderLocation(location: { providerId: string; address: string; city: string; state: string; zip: string }): Promise<ProviderLocation>;
  updateProviderLocation(id: string, updates: UpdateProviderLocationRequest): Promise<ProviderLocation>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  async getUserWithProvider(id: string): Promise<UserWithProvider | null> {
    return prisma.user.findUnique({
      where: { id },
      include: {
        provider: {
          include: {
            services: {
              include: { providerType: true },
            },
          },
        },
      },
    });
  }

  async createUser(user: InsertUser): Promise<User> {
    return prisma.user.create({ data: user });
  }

  async getProvider(id: string): Promise<ProviderWithRelations | null> {
    return prisma.provider.findUnique({
      where: { id },
      include: {
        services: { include: { providerType: true } },
        locations: true,
        ivfSuccessRates: true,
      },
    });
  }

  async getAllProviders(): Promise<ProviderWithRelations[]> {
    return prisma.provider.findMany({
      include: {
        services: { include: { providerType: true } },
        locations: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async createProvider(provider: InsertProvider): Promise<Provider> {
    return prisma.provider.create({ data: provider });
  }

  async updateProvider(id: string, updates: UpdateProviderRequest): Promise<Provider> {
    return prisma.provider.update({ where: { id }, data: updates });
  }

  async getProviderType(id: string): Promise<ProviderType | null> {
    return prisma.providerType.findUnique({ where: { id } });
  }

  async getAllProviderTypes(): Promise<ProviderType[]> {
    return prisma.providerType.findMany({ orderBy: { name: "asc" } });
  }

  async createProviderType(providerType: InsertProviderType): Promise<ProviderType> {
    return prisma.providerType.create({ data: providerType });
  }

  async getProviderServices(providerId: string): Promise<(ProviderService & { providerType: ProviderType })[]> {
    return prisma.providerService.findMany({
      where: { providerId },
      include: { providerType: true },
    });
  }

  async createProviderService(service: { providerId: string; providerTypeId: string; status?: string }): Promise<ProviderService> {
    return prisma.providerService.create({ data: service });
  }

  async updateProviderService(id: string, updates: UpdateProviderServiceRequest): Promise<ProviderService> {
    return prisma.providerService.update({ where: { id }, data: updates });
  }

  async getProviderLocations(providerId: string): Promise<ProviderLocation[]> {
    return prisma.providerLocation.findMany({ where: { providerId } });
  }

  async createProviderLocation(location: { providerId: string; address: string; city: string; state: string; zip: string }): Promise<ProviderLocation> {
    return prisma.providerLocation.create({ data: location });
  }

  async updateProviderLocation(id: string, updates: UpdateProviderLocationRequest): Promise<ProviderLocation> {
    return prisma.providerLocation.update({ where: { id }, data: updates });
  }
}

export const storage = new DatabaseStorage();
