import 'dotenv/config';

export default {
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL, // Use DIRECT_URL (Port 5432) for the push
  },
};
