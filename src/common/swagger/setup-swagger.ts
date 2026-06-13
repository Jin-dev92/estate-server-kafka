import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  SWAGGER_BEARER_AUTH,
  SWAGGER_DESCRIPTION,
  SWAGGER_PATH,
  SWAGGER_TITLE,
  SWAGGER_VERSION,
} from './swagger.constants';

// main.ts(부팅)와 e2e(스모크 테스트)가 공유하는 Swagger 설정 함수.
// 두 곳에서 동일한 설정을 쓰도록 한 곳에 모아 /docs-json 응답을 테스트 가능하게 한다.
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle(SWAGGER_TITLE)
    .setDescription(SWAGGER_DESCRIPTION)
    .setVersion(SWAGGER_VERSION)
    // HTTP Bearer(JWT) 보안 스킴 등록. 두 번째 인자(이름)는 컨트롤러의
    // @ApiBearerAuth(SWAGGER_BEARER_AUTH) 와 일치해야 한다.
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      SWAGGER_BEARER_AUTH,
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document);
}
