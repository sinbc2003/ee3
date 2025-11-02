# 영어 글쓰기 플랫폼 (GCP 버전)

영어 글쓰기 실험 플랫폼을 Google Cloud Run + Cloud Storage 중심 아키텍처로 재구성했습니다. 기존 Google Apps Script + Google Sheet 구조 대신, 다음과 같이 분리된 구조를 사용합니다.

- **프론트엔드**: 정적 `index.html` + 순수 자바스크립트. `app-config.js`에서 Cloud Run 백엔드 주소를 설정합니다.
- **백엔드** (`backend/`): Node.js (Express) 애플리케이션. Cloud Storage에 세션/채팅 데이터를 JSON으로 저장하고, Vertex AI(Gemini)로 AI 피드백을 생성합니다.
- **GitHub Actions**: `master` 브랜치 푸시 시 Cloud Run에 자동 배포.

## 디렉터리 구조

```
.
├─ app-config.js            # 프론트엔드 설정 (Cloud Run API URL 등)
├─ index.html               # 프론트엔드 단일 페이지 애플리케이션
├─ backend/                 # Cloud Run 백엔드 소스
│  ├─ Dockerfile
│  ├─ package.json
│  └─ src/
│     ├─ server.js
│     └─ services/
├─ .github/workflows/deploy.yml  # Cloud Run 배포 파이프라인
└─ README.md
```

## 사전 준비 (GCP)

1. **프로젝트**: `writingresearch` (프로젝트 번호 `711739369323`).
2. **API 활성화**: Cloud Run, Artifact Registry, Cloud Storage, Vertex AI (선택), Secret Manager.
3. **Cloud Storage 버킷**: `writingresearch-app-data` 같은 이름으로 생성 후 버킷 이름을 기억합니다.
4. **서비스 계정**: GitHub Actions에서 사용할 배포용 서비스 계정을 만들고 다음 권한을 부여합니다.
   - Artifact Registry 관리자 (`roles/artifactregistry.admin`)
   - Cloud Run 관리자 (`roles/run.admin`)
   - 서비스 계정 토큰 생성 (`roles/iam.serviceAccountTokenCreator`)
   - Storage 객체 관리자 (`roles/storage.objectAdmin`)
   - Vertex AI 사용자 (`roles/aiplatform.user`, 선택)
   서비스 계정 키(JSON)를 GitHub `GCP_SA_KEY` 비밀 값으로 저장합니다.

## 백엔드 (로컬 개발)

```bash
cd backend
npm install
npm run dev  # nodemon으로 8080 포트에서 실행
```

- 기본적으로 `LOCAL_DATA_DIR`(기본값 `../local-data`)에 JSON 파일로 데이터를 저장합니다.
- Cloud Storage를 사용하려면 `.env` 혹은 실행 환경에 다음을 지정하세요.

```
DATA_BUCKET=writingresearch-app-data
API_KEY=선택_값 (프론트엔드에서 X-API-KEY 헤더로 전달)
ALLOWED_ORIGINS=https://your-frontend-domain.com
AI_PROVIDER=openai # 또는 vertex / (미지정 시 자동 선택)
AI_SYSTEM_PROMPT=당신은 영어 글쓰기 튜터입니다
AI_TEMPERATURE=0.6
VERTEX_MODEL=gemini-1.5-flash          # Vertex AI 사용 시
VERTEX_LOCATION=us-central1            # Vertex AI 리전
OPENAI_API_KEY=sk-...                  # OpenAI 사용 시
OPENAI_MODEL=gpt-4o-mini               # OpenAI 모델 이름
OPENAI_BASE_URL=https://api.openai.com/v1  # 필요 시 커스텀
OPENAI_ORG=org-...                     # (선택) 조직 ID
LIBRE_TRANSLATE_URL=https://libretranslate.de/translate  # 사전 번역용 (선택)
```

## 프론트엔드 설정

`app-config.js`를 열어 Cloud Run 백엔드 URL을 입력합니다.

```javascript
window.APP_CONFIG = {
  apiBaseUrl: 'https://<cloud-run-service>.a.run.app/api',
  apiKey: '' // API 키를 사용하는 경우 입력
};
```

로컬 테스트에서는 `backend`를 8080 포트로 실행한 뒤, 단순 정적 서버(`npx serve .`)로 `index.html`을 띄우면 됩니다.

## GitHub Actions 배포 파이프라인

`.github/workflows/deploy.yml`은 `master` 브랜치 푸시에 Cloud Run으로 자동 배포합니다. 다음 GitHub Secrets를 설정하세요.

| Secret 이름 | 설명 |
|-------------|------|
| `GCP_SA_KEY` | 배포용 서비스 계정 JSON |
| `GCP_PROJECT_ID` | `writingresearch` |
| `GCP_REGION` | 예: `asia-northeast3` |
| `CLOUD_RUN_SERVICE` | Cloud Run 서비스 이름 (예: `writingresearch-api`) |
| `GAR_LOCATION` | Artifact Registry 위치 (예: `asia-northeast1`) |
| `GAR_REPOSITORY` | Artifact Registry 리포지토리 이름 |
| `DATA_BUCKET` | Cloud Storage 버킷 이름 |
| `API_KEY` | (선택) 프론트엔드 요청 검증용 키 |
| `ALLOWED_ORIGINS` | CORS 허용 도메인 (쉼표 구분) |
| `AI_PROVIDER` | `openai` 또는 `vertex` (공백이면 자동 감지) |
| `AI_SYSTEM_PROMPT` | (선택) AI 역활 지침 |
| `AI_TEMPERATURE` | (선택) 0~1 사이 숫자 |
| `VERTEX_MODEL` | (선택) Vertex AI 모델 이름 |
| `VERTEX_LOCATION` | (선택) Vertex AI 위치 |
| `OPENAI_API_KEY` | (선택) OpenAI 키 |
| `OPENAI_MODEL` | (선택) OpenAI 모델 이름 |
| `OPENAI_BASE_URL` | (선택) OpenAI 호스트 URL |
| `OPENAI_ORG` | (선택) OpenAI 조직 ID |
| `LIBRE_TRANSLATE_URL` | (선택) 번역 API 엔드포인트 |

> **참고**: Cloud Run 서비스, Artifact Registry 리포지토리, 버킷 이름은 실제 생성한 값으로 맞춰 주세요.

## 배포 플로우

1. 코드를 커밋 후 `master` 브랜치에 푸시합니다.
2. GitHub Actions가 Docker 이미지를 Artifact Registry에 푸시합니다.
3. 동일 워크플로에서 Cloud Run 서비스에 새 이미지를 배포하고 환경 변수를 업데이트합니다.
4. 프론트엔드 `app-config.js`의 `apiBaseUrl`을 Cloud Run 주소로 맞추면 서비스가 동작합니다.

### 수동 실행 커맨드 (요청하신 포맷)

작업을 마친 후 아래 명령으로 직접 커밋/푸시/배포하세요.

```
git add -A
git commit -m "커밋 메시지"
git push origin master
```

Cloud Run 배포는 GitHub Actions가 담당합니다.

## 추가 개선 아이디어

- **동료 매칭 로직**: 현재는 자리만 마련되어 있으므로, 필요 시 세션별 매칭 로직을 추가하세요.
- **사전 번역 품질**: LibreTranslate 대신 Papago/OpenAI 번역 API 등을 연결하면 품질이 향상됩니다.
- **데이터 백업**: Cloud Storage JSON을 BigQuery/Firestore로 아카이빙하도록 Cloud Functions를 추가할 수 있습니다.
- **모니터링**: Cloud Logging 필터, Error Reporting을 활용해 실시간 상태를 확인해 보세요.

행복한 배포 되세요! 🚀

