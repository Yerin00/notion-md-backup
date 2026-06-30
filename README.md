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