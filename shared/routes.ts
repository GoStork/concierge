import { z } from 'zod';
import {
  insertUserSchema,
  insertProviderSchema,
  insertProviderTypeSchema,
  insertProviderServiceSchema,
  insertProviderLocationSchema,
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
        email: z.string(),
        password: z.string(),
      }),
      responses: {
        200: z.any(),
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
      path: '/api/user' as const,
      responses: {
        200: z.any(),
        401: errorSchemas.unauthorized,
      },
    }
  },
  providers: {
    list: {
      method: 'GET' as const,
      path: '/api/providers' as const,
      responses: {
        200: z.array(z.any()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/providers/:id' as const,
      responses: {
        200: z.any(),
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/providers' as const,
      input: insertProviderSchema,
      responses: {
        201: z.any(),
        400: errorSchemas.validation,
        403: errorSchemas.forbidden,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/providers/:id' as const,
      input: insertProviderSchema.partial(),
      responses: {
        200: z.any(),
        404: errorSchemas.notFound,
        403: errorSchemas.forbidden,
      },
    },
  },
  providerTypes: {
    list: {
      method: 'GET' as const,
      path: '/api/provider-types' as const,
      responses: {
        200: z.array(z.any()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/provider-types' as const,
      input: insertProviderTypeSchema,
      responses: {
        201: z.any(),
        400: errorSchemas.validation,
        403: errorSchemas.forbidden,
      },
    },
  },
  providerServices: {
    list: {
      method: 'GET' as const,
      path: '/api/providers/:providerId/services' as const,
      responses: {
        200: z.array(z.any()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/providers/:providerId/services' as const,
      input: insertProviderServiceSchema.omit({ providerId: true }),
      responses: {
        201: z.any(),
        400: errorSchemas.validation,
        403: errorSchemas.forbidden,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/providers/:providerId/services/:id' as const,
      input: insertProviderServiceSchema.omit({ providerId: true }).partial(),
      responses: {
        200: z.any(),
        404: errorSchemas.notFound,
        403: errorSchemas.forbidden,
      },
    },
  },
  providerLocations: {
    list: {
      method: 'GET' as const,
      path: '/api/providers/:providerId/locations' as const,
      responses: {
        200: z.array(z.any()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/providers/:providerId/locations' as const,
      input: insertProviderLocationSchema.omit({ providerId: true }),
      responses: {
        201: z.any(),
        400: errorSchemas.validation,
        403: errorSchemas.forbidden,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/providers/:providerId/locations/:id' as const,
      input: insertProviderLocationSchema.omit({ providerId: true }).partial(),
      responses: {
        200: z.any(),
        404: errorSchemas.notFound,
        403: errorSchemas.forbidden,
      },
    },
  },
  users: {
    list: {
      method: 'GET' as const,
      path: '/api/users' as const,
      responses: {
        200: z.array(z.any()),
        403: errorSchemas.forbidden,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/users' as const,
      input: insertUserSchema,
      responses: {
        201: z.any(),
        400: errorSchemas.validation,
      },
    },
  },
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
