# Notion 페이지 하위 → Markdown 백업

지정한 **하나의 Notion 페이지 URL** 을 주면, 그 페이지와 **그 하위 전체**(하위 페이지, 하위 데이터베이스의 각 row까지)를 재귀적으로 타고 들어가 **계층 구조 그대로** `.md` 파일로 저장합니다. 워크스페이스 전체가 아니라 **딱 그 페이지 하위만** 대상입니다.

## 1. Notion Integration 토큰 발급 (최초 1회)

1. https://www.notion.so/my-integrations 접속
2. **New integration** 클릭 → 이름 입력(예: `md-backup`) → 워크스페이스 선택 → 저장
3. **Internal Integration Secret** (`secret_...` 또는 `ntn_...`) 복사

## 2. 토큰 등록

```bash
cp .env.example .env
# .env 파일을 열어 NOTION_TOKEN= 뒤에 복사한 토큰을 붙여넣기
```

## 3. ⚠️ 가장 중요: 대상 페이지를 integration에 "연결"

Notion API는 **명시적으로 공유된 페이지만** 읽을 수 있습니다.

- 백업할 페이지를 열고 → 우상단 **•••** → **연결(Connections)** → 위에서 만든 integration 선택
- 이렇게 하면 그 페이지 **및 모든 하위**가 자동으로 접근 가능해집니다. (하위마다 따로 공유할 필요 없음)

## 4. 실행

백업은 모두 `output/` 아래에 모읍니다 (이 폴더는 `.gitignore`로 제외됨 → 개인 데이터가 커밋되지 않음).

```bash
# 루트마다 output/ 아래 원하는 이름으로 저장
node notion-export.mjs "<페이지 URL>" "output/회의록"
node notion-export.mjs "<페이지 URL>" "output/기획문서"

# 폴더명 생략 시 기본값도 output/
node notion-export.mjs "<페이지 URL>"
```

예:
```bash
node notion-export.mjs "https://www.notion.so/My-Page-1a2b3c4d5e6f7890abcdef1234567890"
```

## 출력 구조 (Notion 재임포트 호환)

Notion 공식 export와 **동일한 네이티브 포맷**으로 저장합니다. 파일·폴더 이름 뒤에 페이지 ID(32자리)가 붙고, 이미지는 각 페이지 폴더 안에 들어갑니다. 이래야 Notion import가 `.md`와 폴더를 짝지어 **한 페이지로 합치고** 이미지를 제대로 인식합니다.

```
output/<백업이름>/
├─ 루트페이지 <id>.md            # 루트 페이지 본문
└─ 루트페이지 <id>/              # 같은 이름+ID 폴더 (Notion이 위 .md와 병합)
   ├─ 이미지.png                 # 루트 페이지의 이미지 (동거)
   ├─ 하위페이지 <id>.md
   ├─ 하위페이지 <id>/           # 그 하위의 자식 + 이미지
   │  └─ 손자페이지 <id>.md
   ├─ 내DB <id>.md               # 하위 DB = 전체 row 표 요약 페이지
   └─ 내DB <id>/                 # 각 row가 페이지로 (하위 페이지가 됨)
      ├─ row1 <id>.md
      └─ row2 <id>.md
```

## 이미지 / 데이터베이스 처리

- **이미지·파일**: Notion 업로드 파일은 URL이 ~1시간 뒤 만료되므로 **각 페이지 폴더 안에 다운로드**하고 그 폴더 기준 상대경로로 링크합니다(외부 이미지도 다운로드, 유튜브 등 외부 영상은 링크 유지). 다운로드 실패 시 원본 URL로 폴백.
- **데이터베이스**: 각 row를 개별 페이지(`row <id>.md`)로 저장하고, `내DB <id>.md` 한 장에 전체 row를 **속성 표**로 요약합니다. (Markdown import은 DB를 실제 DB로 복원하진 못하고 페이지 묶음으로 들어옵니다.)
- **제목/속성**: Notion은 파일명을 페이지 제목으로 쓰므로, 본문에 `# 제목` H1과 YAML frontmatter를 넣지 않습니다(제목 중복 방지). DB 속성값은 표 요약에만 담깁니다.

## Notion으로 다시 가져오기 (import)

1. 백업 폴더(`output/<백업이름>`)를 **zip으로 압축**
2. Notion → 좌측 하단 **Import** → **Markdown & CSV** → zip 선택
3. 확인: 하위 페이지가 중첩으로 들어오는지 / 이미지가 보이는지 / 제목이 한 번만 나오는지

## Obsidian 등 다른 도구로 쓰기

표준 Markdown이라 Obsidian 보관소로 그대로 열 수 있습니다. Obsidian 네이티브 임베드(`![[파일]]`)를 원하면:
```bash
LINK_STYLE=wiki node notion-export.mjs "<URL>" "output/<이름>"
```

## 지원하는 블록

문단 / 제목 / 글머리·번호·체크박스 목록 / 토글 / 인용 / 콜아웃 / 코드 / 구분선 /
이미지·파일·동영상 / 북마크·임베드 / 표(table) / 수식 / 하위 페이지 / 하위 DB / 컬럼 레이아웃.

지원하지 않는 일부 블록은 무시되며, 변환 오류가 나도 해당 부분만 건너뛰고 계속 진행합니다.
