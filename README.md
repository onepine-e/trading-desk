# 트레이딩 데스크

나만의 가상 거래소입니다. GitHub Pages로 띄우고, 기록은 비공개 저장소 `tsb7-paper`의 `desk/` 폴더에 저장합니다.

- **차트:** 트레이딩뷰 위젯을 씁니다. 지표·그리기 도구는 차트 안에서 설정하고, 기본 지표·봉은 설정 탭에서 정합니다.
- **실시간 시세·호가:** 업비트 원화 현물, 바이낸스 USDT 무기한 선물
- **주문:**
  - 현물: 매수·매도
  - 선물: 롱·숏, 레버리지 1~125배(격리), 펀딩비 8시간마다
  - 시장가 · 지정가 · 조건(돌파·이탈), 손절·익절
- **놓친 체결:** 화면을 닫아 둔 동안 지정가·손절·익절·강제청산 가격에 닿았으면, 다시 열 때 그 사이 캔들(5분봉)의 시가·고가·저가로 확인해서 체결합니다.
  - 한 캔들에 손절과 익절이 모두 닿으면 손절로 처리합니다.
  - 시가가 이미 더 불리한(또는 유리한) 곳에서 시작하면 시가로 체결합니다.
- **매매 일지:** 진입할 때 셋업·감정·이유를 남기고, 청산 뒤 돌아보기와 규칙 준수 여부를 기록합니다.
  - 통계 탭에서 셋업별·감정별 승률, 손익비, 거래당 기대값(원/USDT와 R)을 보여 줍니다.
  - 100회 진행률도 함께 보여 줍니다.
- **Claude 계좌·브리핑:** Claude가 브리핑 때 `desk/claude/orders.json`에 주문을 넣으면, 가상매매 봇(GitHub Actions)이 실행될 때마다 15분봉으로 체결을 계산해 `desk/claude/state.json`에 씁니다. 브리핑은 `desk/briefings/`에 쌓입니다.
- **봇 계좌:** `paper/*/equity.csv`와 일일 대조(`paper/reconcile.csv`)를 보여 줍니다.

## 설치 (한 번만)

1. **공개 저장소 `trading-desk` 만들기**
   - 무료 계정의 GitHub Pages는 공개 저장소에서만 됩니다. 여기에는 화면 코드만 올리고, 기록은 비공개 `tsb7-paper`에 둡니다.
   - `index.html`, `engine.js`, `app.js`, `README.md`를 올립니다.
2. **Pages 켜기:** Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save
   - 1~2분 뒤 `https://<아이디>.github.io/trading-desk/` 에서 열립니다.
3. **`tsb7-paper` 저장소에 `desk/` 폴더 올리기**
   - 올릴 파일: `engine.js`, `claude_engine.js`, `claude/orders.json`, `briefings/index.json`
   - 워크플로 파일 `.github/workflows/paper.yml`도 새것으로 교체합니다. Claude 계좌 체결 단계가 추가됐습니다.
4. **화면용 토큰 만들기**
   - GitHub → Settings → Developer settings → Fine-grained tokens
   - Repository access는 `tsb7-paper` 하나만 고릅니다.
   - Permissions → Repository permissions → **Contents: Read and write**를 줍니다.
   - cron-job.org에 쓴 토큰(Actions 권한)과는 따로 만드는 걸 권합니다.
5. **화면에서 연결:** 설정 탭 → 저장소 주인(아이디) · `tsb7-paper` · `main` · 토큰 → "저장하고 연결"
   - 폰에서도 같은 방법으로 한 번 연결하면, 폰과 PC가 같은 계좌를 봅니다.

## 알아둘 점

- 토큰은 그 기기의 브라우저에만 저장됩니다. 공용 PC에서는 넣지 마세요.
- **"놓친 구간 확인 실패"가 뜰 때:** 브라우저가 업비트·바이낸스 REST API를 막은 경우입니다(광고 차단기, 회사망 등). 그때는 실시간 체결만 반영되고, 다음에 열 때 다시 확인합니다.
- **Claude 선물 계좌의 가격:** GitHub 서버(미국)에서는 바이낸스 선물 API가 막혀 있어서 바이낸스 현물 USDT 가격으로 계산합니다. 차이는 보통 0.1% 안쪽이고, 펀딩비는 반영하지 않습니다.
- **`engine.js`는 두 곳에 같은 파일이 있습니다** (`trading-desk/engine.js`, `tsb7-paper/desk/engine.js`). 바꿀 때는 둘 다 바꿔야 화면과 Claude 계좌가 같은 규칙으로 체결됩니다.
