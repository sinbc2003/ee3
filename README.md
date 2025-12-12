# 영어 글쓰기 플랫폼 (GCP 버전)

영어 글쓰기 실험 플랫폼을 Google Cloud Run + Cloud Storage 중심 아키텍처로 재구성했습니다. 기존 Google Apps Script + Google Sheet 구조 대신, 다음과 같이 분리된 구조를 사용합니다.

- **프론트엔드**: 정적 `index.html` + 순수 자바스크립트. `app-config.js`에서 Cloud Run 백엔드 주소를 설정합니다.
- **백엔드** (`backend/`): Node.js (Express) 애플리케이션. Cloud Storage에 세션/채팅 데이터를 JSON으로 저장하고, Vertex AI(Gemini)로 AI 피드백을 생성합니다.
- **GitHub Actions**: `master` 브랜치 푸시 시 Cloud Run에 자동 배포.

> 현재 플랫폼은 단일 집단(A)을 기본으로 사용합니다. 학생은 집단 선택 없이 식별 번호와 이름만 입력하면 세션이 시작되며, 관리자 페이지에서 차시별 안내/발문/AI 프롬프트를 직접 편집할 수 있습니다.

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
 
이 저장소는 현재 **test12** 프로젝트(ID `test12-481000`, 번호 `711121900388`) 기준으로 설명합니다. Cloud Shell에서 아래 변수를 먼저 정의하면 나머지 명령을 그대로 붙여넣기만 하면 됩니다.

```bash
export PROJECT_ID=test12-481000
export PROJECT_NUMBER=711121900388
export REGION=asia-northeast3          # Cloud Run/버킷 리전
export GAR_LOCATION=asia-northeast3    # Artifact Registry 리전
export GAR_REPOSITORY=ee3              # 원하는 리포지토리 이름
export SERVICE_NAME=ee3-backend        # Cloud Run 서비스 이름
export BUCKET=test12-writingresearch-data
export SA_ID=github-actions-deployer   # 서비스 계정 ID
export POOL_ID=github-actions-pool     # Workload Identity Pool ID
export PROVIDER_ID=github-actions      # Workload Identity Provider ID
```

1. **프로젝트 선택 & API 활성화**  
   ```bash  
   gcloud config set project $PROJECT_ID
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com iamcredentials.googleapis.com storage.googleapis.com secretmanager.googleapis.com logging.googleapis.com compute.googleapis.com
   ```
2. **Artifact Registry Docker 리포지토리 생성**
   ```bash
   gcloud artifacts repositories create $GAR_REPOSITORY \
     --project=$PROJECT_ID \
     --repository-format=docker \
     --location=$GAR_LOCATION \
     --description="ee3 images"
   ```
3. **Cloud Storage 버킷 생성**
   ```bash
   gsutil mb -p $PROJECT_ID -l $REGION -b on gs://$BUCKET
   ```
4. **GitHub Actions 배포용 서비스 계정 생성 및 권한 부여**
   ```bash
   gcloud iam service-accounts create $SA_ID \
     --project=$PROJECT_ID \
     --display-name="GitHub Actions deployer"
   SA_EMAIL=${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com
   for role in roles/run.admin roles/iam.serviceAccountTokenCreator roles/storage.objectAdmin roles/artifactregistry.writer; do
     gcloud projects add-iam-policy-binding $PROJECT_ID \
       --member="serviceAccount:${SA_EMAIL}" \
       --role="$role"
   done
   ```
5. **Workload Identity Federation 연결 (GitHub Actions ↔ GCP)**
   ```bash
   gcloud iam workload-identity-pools create $POOL_ID \
     --project=$PROJECT_ID \
     --location=global \
     --display-name="GitHub Actions pool"

   gcloud iam workload-identity-pools providers create-oidc $PROVIDER_ID \
     --project=$PROJECT_ID \
     --location=global \
     --workload-identity-pool=$POOL_ID \
     --display-name="GitHub Actions provider" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
     --attribute-condition="assertion.repository=='sinbc2003/ee3'" \
     --issuer-uri="https://token.actions.githubusercontent.com"

   gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
     --project=$PROJECT_ID \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/sinbc2003/ee3"
   ```
6. **Provider 리소스 이름 확인 (GitHub 비밀 값으로 사용)**
   ```bash
   gcloud iam workload-identity-pools providers describe $PROVIDER_ID \
     --project=$PROJECT_ID \
     --location=global \
     --workload-identity-pool=$POOL_ID \
     --format='value(name)'
   # 출력 예) projects/711121900388/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions
   ```

위 명령들을 순서대로 실행하면 Cloud Run 배포에 필요한 GCP 리소스가 모두 준비됩니다. Vertex AI를 쓰고 싶다면 `gcloud services enable aiplatform.googleapis.com`와 `roles/aiplatform.user` 권한도 추가하세요.

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
ADMIN_PASSWORD=159753tt!
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

관리자는 `/admin` 화면의 **차시 안내** 섹션에서 2차시~4차시-2에 해당하는 단계 이름·헤드라인·설명 문구뿐 아니라 차시별 발문/자료와(필요 시) AI 시스템 프롬프트까지 수정할 수 있습니다. 저장하면 학생 화면 상단, 단계 패널, 우측 채팅 패널, AI 웹검색/토론 영역, 그리고 Perplexity/OpenAI 호출 시에도 즉시 반영됩니다.

로컬 테스트에서는 `backend`를 8080 포트로 실행한 뒤, 단순 정적 서버(`npx serve .`)로 `index.html`을 띄우면 됩니다.

## GitHub Actions 배포 파이프라인

`.github/workflows/deploy.yml`은 `master` 브랜치 푸시에 Cloud Run으로 자동 배포합니다. 다음 GitHub Secrets를 설정하세요.

| Secret 이름 | 설명 |
|-------------|------|
| `GCP_PROJECT_ID` | `test12-481000` |
| `GCP_REGION` | Cloud Run 리전 (예: `asia-northeast3`) |
| `CLOUD_RUN_SERVICE` | Cloud Run 서비스 이름 (예: `ee3-backend`) |
| `GAR_LOCATION` | Artifact Registry 위치 (예: `asia-northeast3`) |
| `GAR_REPOSITORY` | Artifact Registry 리포지토리 이름 (예: `ee3`) |
| `GCP_WIF_PROVIDER` | `projects/711121900388/locations/global/workloadIdentityPools/.../providers/...` |
| `GCP_WIF_SERVICE_ACCOUNT` | `github-actions-deployer@test12-481000.iam.gserviceaccount.com` |
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
| `PERPLEXITY_API_KEY` | (선택) Perplexity API 키 |
| `PERPLEXITY_MODEL` | (선택) Perplexity 모델 이름 |
| `LIBRE_TRANSLATE_URL` | (선택) 번역 API 엔드포인트 | 
| `ADMIN_PASSWORD` | (선택) 관리자 페이지 비밀번호 |

> **참고**: Cloud Run 서비스, Artifact Registry 리포지토리, 버킷 이름은 실제 생성한 값으로 맞춰 주세요.

## 배포 플로우

1. 코드를 커밋 후 `master` 브랜치에 푸시합니다.
2. GitHub Actions가 Docker 이미지를 Artifact Registry에 푸시합니다.
3. 동일 워크플로에서 Cloud Run 서비스에 새 이미지를 배포하고 환경 변수를 업데이트합니다.
4. 프론트엔드 `app-config.js`의 `apiBaseUrl`을 Cloud Run 주소로 맞추면 서비스가 동작합니다.
5. Cloud Run 서비스 URL(예: `https://writingresearch-api-711739369323.asia-northeast3.run.app/`)로 접속하면 `index.html`이 자동으로 서빙되며, `https://.../admin`에서는 관리자 대시보드를 이용할 수 있습니다.

### 수동 실행 커맨드 (요청하신 포맷)

작업을 마친 후 아래 명령으로 직접 커밋/푸시/배포하세요.

```
git add -A
git commit -m "커밋 메시지"
git push origin master
```

Cloud Run 배포는 GitHub Actions가 담당합니다.

## 추가 개선 아이디어

- **관리자 대시보드**: `admin.html`로 접속하면 비밀번호(기본값 `159753tt!`) 입력 후 세션 현황, 채팅 로그, AI 설정(OpenAI/Vertex AI 전환, 모델/프롬프트/온도 등)을 웹 UI에서 바로 확인·수정할 수 있습니다. `ADMIN_PASSWORD` 시크릿이나 환경 변수로 비밀번호를 변경하세요.
- **동료 매칭 로직**: 현재는 자리만 마련되어 있으므로, 필요 시 세션별 매칭 로직을 추가하세요.
- **사전 번역 품질**: LibreTranslate 대신 Papago/OpenAI 번역 API 등을 연결하면 품질이 향상됩니다.
- **데이터 백업**: Cloud Storage JSON을 BigQuery/Firestore로 아카이빙하도록 Cloud Functions를 추가할 수 있습니다.
- **모니터링**: Cloud Logging 필터, Error Reporting을 활용해 실시간 상태를 확인해 보세요.

행복한 배포 되세요! 🚀

