import { 
  users, providers, inventory,
  type User, type InsertUser, 
  type Provider, type InsertProvider,
  type InventoryItem, type InsertInventoryItem,
  type UpdateProviderRequest, type UpdateInventoryRequest
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Providers
  getProvider(id: number): Promise<Provider | undefined>;
  getAllProviders(type?: string): Promise<Provider[]>;
  createProvider(provider: InsertProvider): Promise<Provider>;
  updateProvider(id: number, provider: UpdateProviderRequest): Promise<Provider>;

  // Inventory
  getInventoryItem(id: number): Promise<InventoryItem | undefined>;
  getInventory(providerId?: number, type?: string): Promise<InventoryItem[]>;
  createInventoryItem(item: InsertInventoryItem): Promise<InventoryItem>;
  updateInventoryItem(id: number, item: UpdateInventoryRequest): Promise<InventoryItem>;
}

export class DatabaseStorage implements IStorage {
  // Users
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  // Providers
  async getProvider(id: number): Promise<Provider | undefined> {
    const [provider] = await db.select().from(providers).where(eq(providers.id, id));
    return provider;
  }

  async getAllProviders(type?: string): Promise<Provider[]> {
    if (type) {
      return await db.select().from(providers).where(eq(providers.type, type as any));
    }
    return await db.select().from(providers);
  }

  async createProvider(insertProvider: InsertProvider): Promise<Provider> {
    const [provider] = await db.insert(providers).values(insertProvider).returning();
    return provider;
  }

  async updateProvider(id: number, updates: UpdateProviderRequest): Promise<Provider> {
    const [provider] = await db.update(providers)
      .set(updates)
      .where(eq(providers.id, id))
      .returning();
    return provider;
  }

  // Inventory
  async getInventoryItem(id: number): Promise<InventoryItem | undefined> {
    const [item] = await db.select().from(inventory).where(eq(inventory.id, id));
    return item;
  }

  async getInventory(providerId?: number, type?: string): Promise<InventoryItem[]> {
    let query = db.select().from(inventory);
    
    // Simple dynamic query building
    const filters = [];
    if (providerId) filters.push(eq(inventory.providerId, providerId));
    if (type) filters.push(eq(inventory.type, type));

    if (filters.length > 0) {
      // @ts-ignore - simple 'and' logic
      return await query.where(...filters);
    }
    
    return await query;
  }

  async createInventoryItem(item: InsertInventoryItem): Promise<InventoryItem> {
    const [newItem] = await db.insert(inventory).values(item).returning();
    return newItem;
  }

  async updateInventoryItem(id: number, updates: UpdateInventoryRequest): Promise<InventoryItem> {
    const [item] = await db.update(inventory)
      .set(updates)
      .where(eq(inventory.id, id))
      .returning();
    return item;
  }
}

export const storage = new DatabaseStorage();
