# Threads 자동 게시 (GitHub Actions)

컴퓨터 없이, GitHub 서버가 **매일 12시(한국 시간)**에 `products.csv`의 다음 상품을
Threads에 1개씩 올립니다. 모든 설정은 휴대폰 브라우저로 할 수 있습니다.
(GitHub·Meta 화면은 브라우저 메뉴의 **"데스크톱 사이트"**를 켜면 편합니다.)

```
GitHub (매일 12시) ── Groq 무료 AI로 글 생성 ── Threads에 게시 ── 다음 상품 번호 저장
```

## 0. 이 기능을 main 브랜치에 넣기
GitHub의 예약 실행은 **기본 브랜치(main)에 있는 워크플로만** 돌립니다.
`claude/wizardly-bohr-xskesg` 브랜치를 main에 병합(PR 머지)해야 시작됩니다.
병합 후 저장소 **Actions** 탭에 "Workflows aren't being run…" 안내가 보이면 **Enable** 을 누르세요.

## 1. Groq API 키 (글 생성용, 무료)
1. https://console.groq.com 가입 → **API Keys** → **Create API Key** → 복사
2. GitHub 저장소 → **Settings → Secrets and variables → Actions → Secrets → New repository secret**
   - Name: `LLM_API_KEY` / Secret: 복사한 키

> 기본 모델은 Groq 무료 플랜의 `openai/gpt-oss-120b` 입니다 (분당 30회·하루 1,000회,
> console.groq.com/docs/rate-limits, 2026-11-21 확인). 바꾸려면 **Variables** 에 `LLM_MODEL` 을 추가하세요.

## 2. Meta(Threads) 앱 만들기
1. https://developers.facebook.com → **앱 만들기** → 사용 사례 **Threads** 선택
2. **App settings → Basic** 에서 **Threads App ID**, **Threads App secret** 확인
   (앱 ID가 2개 있으니 꼭 *Threads* 쪽)
3. 같은 설정의 **Redirect callback URLs** 에 `https://localhost/` 등록
4. **App roles → Roles → Add People → Threads Tester** 로 내 Threads 계정 초대 →
   Threads 앱 **설정 → 계정 → 웹사이트 권한** 에서 수락
5. GitHub **Secrets** 에 두 개 추가:
   - `THREADS_APP_ID` = Threads App ID
   - `THREADS_APP_SECRET` = Threads App secret

## 3. 토큰 저장용 GitHub 토큰 만들기
토큰 발급·갱신 워크플로가 Threads 토큰을 Secrets에 **직접 저장**하게 해 줍니다.
(그래서 Threads 토큰을 눈으로 보거나 붙여넣을 일이 없습니다.)
1. GitHub 프로필 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Repository access: **Only select repositories** → `freellmapi`
3. Permissions → Repository permissions → **Secrets: Read and write**
4. 만료일은 길게(예: 1년) → 생성 후 복사
5. 저장소 **Secrets** 에 `SECRETS_WRITE_TOKEN` 으로 추가
   (만료되면 새로 만들어 같은 이름으로 교체)

## 4. Threads 토큰 받기 (처음 한 번)
1. 휴대폰 브라우저에서 아래 주소 열기 (`<앱ID>` 를 바꿔서):
   ```
   https://threads.com/oauth/authorize?client_id=<앱ID>&redirect_uri=https://localhost/&scope=threads_basic,threads_content_publish&response_type=code
   ```
2. **허용** → 페이지가 안 열려도 OK. 주소창의 `code=` 뒤 값을 전부 복사
3. GitHub **Actions → Threads token → Run workflow**
   - mode: `exchange`, code: 복사한 값 → **Run** (1시간 안에, 코드는 한 번만 사용 가능)
4. 초록 체크가 뜨면 `THREADS_ACCESS_TOKEN` 이 자동 저장된 것입니다.

> 이후에는 **매달 1일 자동 갱신**됩니다(토큰 유효기간 60일). 갱신이 실패해 만료되면 4단계를 다시 하세요.

## 5. 광고 문구와 말투
저장소 **Settings → Secrets and variables → Actions → Variables → New repository variable**
- `THREADS_DISCLOSURE` (필수): 쿠팡 파트너스가 요구하는 문구. 파트너스 공지에서 최신 문구를 확인해 그대로 넣으세요.
  예) `이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.`
- `THREADS_STYLE` (선택): 글 말투. 예) `친근한 말투, 한국어, 3~4문장`

## 6. 상품 목록
1. 저장소에서 `threads/products.example.csv` 열기 → 내용 복사
2. **Add file → Create new file** → 이름 `threads/products.csv` → 붙여넣고 실제 상품으로 수정 → **Commit**
```csv
name,link,info
무선 청소기 A,https://link.coupang.com/a/진짜링크,"무게 1.2kg, 배터리 최대 40분"
```
- 첫 줄 `name,link,info` 는 그대로. 쉼표가 들어간 칸은 `"..."` 로 감싸기
- `info` 에는 **사실만**. AI는 이 내용만으로 글을 쓰고, 써 본 척하는 후기는 쓰지 않습니다.

## 7. 미리보기 → 확인
**Actions → Threads auto-post → Run workflow** (dry_run 체크된 상태) → 실행 기록의
**Generate and post** 단계를 열면 생성된 글이 보입니다. **게시되지 않습니다.**

괜찮으면 dry_run 체크를 **해제**하고 한 번 더 실행 → Threads에 실제로 올라가는지 확인.
이후로는 매일 12시에 자동으로 다음 상품이 올라갑니다 (GitHub 사정으로 몇 분~수십 분 늦을 수 있음).

## 일반 글 섞기 (자동)
광고 글만 올라가면 스팸처럼 보이기 쉬워서, 링크 없는 일반 글을 사이사이 올립니다.
- `threads/posts.csv` 의 글을 위에서부터 한 개씩, **쓴 그대로** 올립니다 (AI 생성 아님).
- 일정: 매일 20:00, 그리고 월·수·금 09:00 (한국 시간). 광고 글(12:00)과 합쳐 하루 2~3개.
- 미리보기: **Actions → Threads general posts → Run workflow** (dry_run 체크 상태).
- 글 추가·수정: `threads/posts.csv` 편집. 첫 줄은 `text`, 여러 줄 글은 `"..."` 로 감싸기.
  일반 글에는 링크를 넣을 수 없습니다(광고 글은 products.csv로).

## 관리
| 하고 싶은 것 | 방법 |
| --- | --- |
| 상품 추가/수정 | `threads/products.csv` 편집 |
| 처음 상품부터 다시 | `threads/products.csv.state` 파일 삭제 |
| 잠시 멈추기 | Actions → Threads auto-post → **…** → Disable workflow |
| 시간 바꾸기 | `.github/workflows/threads-post.yml` 의 `cron` (UTC 기준, 한국시간 −9시간) |

## 오류가 나면
실행 기록의 빨간 단계를 열어 `Error:` 줄을 확인하세요.

| 메시지 | 해결 |
| --- | --- |
| `Add the ... secret/variable` | 해당 Secret/Variable 이름 철자 확인 후 추가 |
| `REPLACE_ME links` | products.csv에 예시 링크가 남아 있음 |
| `Code exchange failed` | 코드가 1시간 지났거나 이미 사용됨 → 4단계 1번부터 다시 |
| `Threads API ... HTTP 400/401` | 토큰 만료 → 4단계 다시 |
| `Gateway chat request failed (HTTP 401)` | `LLM_API_KEY`(Groq 키) 확인 |
| `quota used up` | Threads 24시간 게시 한도(250개) 초과 |

**공개 저장소라면** `products.csv` 와 실행 기록(생성된 글)은 누구나 볼 수 있습니다.
Secrets 값은 보이지 않습니다.
