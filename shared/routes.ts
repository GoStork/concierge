import { z } from 'zod';
import { 
  insertUserSchema, 
  insertProviderSchema, 
  insertInventorySchema,
  users,
  providers,
  inventory
} from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
  unauthorized: z.object({
    message: z.string(),
  }),
  forbidden: z.object({
    message: z.string(),
  }),
};

export const api = {
  auth: {
    login: {
      method: 'POST' as const,
      path: '/api/auth/login' as const,
      input: z.object({
        username: z.string(),
        password: z.string(),
      }),
      responses: {
        200: z.custom<typeof users.$inferSelect>(),
        401: errorSchemas.unauthorized,
      },
    },
    logout: {
      method: 'POST' as const,
      path: '/api/auth/logout' as const,
      responses: {
        200: z.object({ message: z.string() }),
      },
    },
    me: {
      method: 'GET' as const,
      path: '/api/user' as const, // Standard passport convention often uses /user or /me
      responses: {
        200: z.custom<typeof users.$inferSelect>(),
        401: errorSchemas.unauthorized,
      },
    }
  },
  providers: {
    list: {
      method: 'GET' as const,
      path: '/api/providers' as const,
      input: z.object({
        type: z.string().optional(), // Filter by CLINIC, AGENCY, etc.
      }).optional(),
      responses: {
        200: z.array(z.custom<typeof providers.$inferSelect>()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/providers/:id' as const,
      responses: {
        200: z.custom<typeof providers.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/providers' as const,
      input: insertProviderSchema,
      responses: {
        201: z.custom<typeof providers.$inferSelect>(),
        400: errorSchemas.validation,
        403: errorSchemas.forbidden, // Only Admin
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/providers/:id' as const,
      input: insertProviderSchema.partial(),
      responses: {
        200: z.custom<typeof providers.$inferSelect>(),
        404: errorSchemas.notFound,
        403: errorSchemas.forbidden,
      },
    },
  },
  users: {
    // For admins to manage users or Providers to manage their staff
    list: {
      method: 'GET' as const,
      path: '/api/users' as const,
      input: z.object({
        providerId: z.coerce.number().optional(),
      }).optional(),
      responses: {
        200: z.array(z.custom<typeof users.$inferSelect>()),
        403: errorSchemas.forbidden,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/users' as const,
      input: insertUserSchema,
      responses: {
        201: z.custom<typeof users.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
  },
  inventory: {
    list: {
      method: 'GET' as const,
      path: '/api/inventory' as const,
      input: z.object({
        providerId: z.coerce.number().optional(),
        type: z.string().optional(),
      }).optional(),
      responses: {
        200: z.array(z.custom<typeof inventory.$inferSelect>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/inventory' as const,
      input: insertInventorySchema,
      responses: {
        201: z.custom<typeof inventory.$inferSelect>(),
        400: errorSchemas.validation,
        403: errorSchemas.forbidden,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/inventory/:id' as const,
      input: insertInventorySchema.partial(),
      responses: {
        200: z.custom<typeof inventory.$inferSelect>(),
        404: errorSchemas.notFound,
        403: errorSchemas.forbidden,
      },
    },
  }
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
