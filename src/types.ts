import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; bus_id: string; typ: 'device' };
    user: { sub: string; bus_id: string; typ: 'device' };
  }
}
