import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // 프로덕션에서는 전체 API 표면을 인증 없이 노출하지 않도록 /docs 를 끈다.
  // (e2e 는 setupSwagger 를 직접 호출하므로 이 가드의 영향을 받지 않는다.)
  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    setupSwagger(app);
  }
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
