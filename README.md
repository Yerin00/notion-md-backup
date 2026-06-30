# Notion 페이지 하위 → Markdown 백업

지정한 **하나의 Notion 페이지 URL** 을 주면, 그 페이지와 **그 하위 전체**(하위 페이지, 하위 데이터베이스의 각 row까지)를 재귀적으로 타고 들어가 **계층 구조 그대로** `.md` 파일로 저장합니다. 워크스페이스 전체가 아니라 **딱 그 페이지 하위만** 대상입니다.

## 1. Notion Integration 토큰 발급 (최초 1회)

1. https://app.notion.com/developers/tokens 접속
2. 새 토큰 클릭
3. 워크스페이스 선택
4. Notion API 선택
5. 토큰 생성하기

## 2. 토큰 등록

```bash
cp .env.example .env
# .env 파일을 열어 NOTION_TOKEN= 뒤에 복사한 토큰을 붙여넣기
```

## 3. 실행

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

## 동작 / 참고

- **출력 구조**: 페이지마다 자기 폴더(`<페이지>/<페이지>.md` + `assets/` + 하위 폴더). 사람이 읽기 좋고 Obsidian/VS Code에서 그대로 열림.
- **이미지**: 각 페이지 `assets/`에 다운로드(Notion 업로드 파일은 URL이 만료되므로). 외부 이미지도 받고, 유튜브 등 외부 영상은 링크 유지.
- **링크된 Notion 페이지(1단계)**: 본문이 다른 Notion 페이지를 링크/멘션하면, 그 페이지를 **1단계만** 자동으로 가져옴 — 이미 받은 하위 트리 안이면 로컬 파일로 연결, 밖이면 `_linked/`로 받아 연결. 권한 없는 링크는 URL 그대로 유지. (그 페이지의 또 다른 링크까지는 따라가지 않음 → 순환 없음). 끄려면 `FETCH_LINKED=0`.
- **데이터베이스**: 뷰의 필터·정렬은 무시되고 전체 row가 받아짐. 각 row는 페이지로, `<DB>.md`에 표로도 요약.
- **생성자 기준 정리**: `node cleanup-by-creator.mjs "<폴더>" --keep "이름"` (미리보기) → 확인 후 `--apply`. DB row의 `생성자` frontmatter 기준으로 폴더째 삭제.
- **Obsidian 임베드**(`![[..]]`) 형식: `LINK_STYLE=wiki` 환경변수.
