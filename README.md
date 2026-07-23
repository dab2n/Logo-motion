# Logo Match Cut Studio

로고 모션 영상을 프레임으로 분해하고, 로고만 분리한 뒤 프레임마다 다른 배경을 합성해
**Logo Match Cut** 영상을 만드는 웹 툴. 외부 AI 이미지 도구로 가공한 프레임을 다시
불러와 하나의 영상으로 재조합하는 것까지 한 흐름으로 지원한다.

## 실행

빌드·서버 불필요. 정적 파일이다.

```bash
# 아무 정적 서버로 열면 됨 (파일 프로토콜은 일부 브라우저에서 제한될 수 있음)
python3 -m http.server 8000
# → http://localhost:8000
```

Chrome 계열 권장 (`MediaRecorder`, `captureStream` 사용).

## 흐름

1. **업로드** — 로고 모션 영상 업로드
2. **프레임 추출** — 지정 FPS / 일정 간격(초) / 전체(원본 FPS 지정)
3. **로고 분리** — 흰 배경을 투명하게. 3가지 방식:
   - `Luminance 매트` (권장): 밝기를 그대로 투명도로. Figma의 Multiply와 동등하되 실제 알파 채널로 추출
   - `Threshold + 페더`: 임계값 + 부드러운 경계
   - `Threshold 하드`: 이진 마스크
4. **배경 적용** — 여러 배경 업로드 후 배치: 순서대로 / 일정 프레임 간격 / 프레임별 직접 지정
5. **미리보기** — 합성 결과를 재생. 재생 FPS·배경 전환 간격 조절, 스크럽
6. **내보내기** — 프레임 ZIP 일괄 저장(순서 파일명) / WebM 영상. 합성본 또는 로고 투명 PNG 선택
7. **가공본 재조합** — 외부에서 가공한 프레임 업로드 → 파일명 자연 정렬 → 재생 → WebM 내보내기

## 기술

순수 클라이언트. 백엔드·빌드 없음.

- 프레임 추출: `<video>` seek + Canvas `drawImage`
- 로고 분리: Canvas `getImageData` 픽셀 매트 (`app.js`의 `separate()`)
- 합성/재생: Canvas
- 프레임 저장: JSZip (CDN)
- 영상 내보내기: `canvas.captureStream()` + `MediaRecorder` (WebM)

`node test.js` — 픽셀 매트 로직 자체 검증.

## 알려진 한계 / 확장 지점

- **전체 프레임 추출**은 브라우저에서 원본 정확 FPS를 알 수 없어 사용자가 지정한 FPS로 근사한다.
  정확도가 필요하면 `WebCodecs`로 교체.
- **WebM만 지원**. MP4가 필요하면 `ffmpeg.wasm` 추가.
- 프레임을 메모리에 Canvas로 보관 → 프레임 수가 많으면 무거움. 대량 처리 시 IndexedDB/스트리밍으로 확장.
- 배경 합성은 cover 스케일 고정. 위치·블렌드모드·오프셋은 추후 확장 가능.
