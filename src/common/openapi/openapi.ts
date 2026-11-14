/**
 * One OpenAPI document per surface (spec section 4.2), built from the same response
 * schemas the Fastify serializer uses, and rendered with Scalar at `/docs/{surface}`
 * with the JSON at `/docs/{surface}/openapi.json`.
 *
 * Docs are served only when ENABLE_API_DOCS=true, which env validation refuses in
 * production until authenticated docs exist.
 */
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import scalar from '@scalar/fastify-api-reference';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { SURFACES, type SurfaceKey } from '../../surfaces/surfaces';
import { docsCsp } from '../http/security-headers';

export const API_VERSION = '0.1.0';

export function buildOpenApiDocuments(app: INestApplication): Record<SurfaceKey, OpenAPIObject> {
  const documents = {} as Record<SurfaceKey, OpenAPIObject>;
  for (const surface of SURFACES) {
    const config = new DocumentBuilder()
      .setTitle(surface.title)
      .setDescription(surface.description)
      .setVersion(API_VERSION)
      .build();
    const document = SwaggerModule.createDocument(app, config, {
      include: [...surface.documentModules],
      deepScanRoutes: false,
    });
    documents[surface.key] = cleanupOpenApiDoc(document);
  }
  return documents;
}

export async function registerApiDocs(
  app: NestFastifyApplication,
  documents: Record<SurfaceKey, OpenAPIObject>
): Promise<void> {
  // One nonce per process; the docs pages contain no user-supplied content.
  const nonce = randomBytes(16).toString('base64');
  const csp = docsCsp(nonce);
  for (const surface of SURFACES) {
    await app.register(scalar, {
      routePrefix: `/docs/${surface.key}`,
      configuration: {
        content: documents[surface.key],
        pageTitle: surface.title,
        nonce,
        withDefaultFonts: false,
        telemetry: false,
      },
      hooks: {
        onRequest: (_request, reply, done) => {
          void reply.header('content-security-policy', csp);
          done();
        },
      },
      logLevel: 'warn',
    });
  }
}
