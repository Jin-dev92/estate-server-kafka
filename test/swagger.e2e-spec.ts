import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/common/swagger/setup-swagger';

// Swagger 스모크 e2e: setupSwagger 가 OpenAPI 문서를 정상 생성하고
// /docs-json 으로 노출되는지(부팅 연결의 핵심)만 빠르게 검증한다.
describe('Swagger (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /docs-json → 200 + openapi 문서(paths 비어있지 않음)', async () => {
    await request(app.getHttpServer() as App)
      .get('/docs-json')
      .expect(200)
      .expect((res) => {
        const body = res.body as {
          openapi: string;
          paths: Record<string, unknown>;
        };
        expect(typeof body.openapi).toBe('string');
        expect(typeof body.paths).toBe('object');
        expect(Object.keys(body.paths).length).toBeGreaterThan(0);
      });
  });
});
