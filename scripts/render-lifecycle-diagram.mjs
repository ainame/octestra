import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const japaneseOutput = resolve(root, "docs/assets/lifecycle.ja.svg");
const englishOutput = resolve(root, "docs/assets/lifecycle.svg");

const nodes = [
  { id: "todo", label: "Todo", x: 80, y: 230, width: 150 },
  { id: "ready", label: "Ready", x: 320, y: 230, width: 150 },
  { id: "in-progress", label: "In Progress", x: 560, y: 230, width: 190 },
  { id: "validation", label: "Validation", x: 850, y: 230, width: 190 },
  { id: "human-review", label: "Human Review", x: 1130, y: 230, width: 200 },
  { id: "done", label: "Done", x: 1420, y: 230, width: 150 },
  { id: "blocked", label: "Blocked", x: 720, y: 455, width: 250 },
];

function renderNode(node) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + 38;
  return `
    <g class="node" id="${node.id}">
      <rect x="${node.x}" y="${node.y}" width="${node.width}" height="76" rx="14" />
      <text x="${centerX}" y="${centerY}">${node.label}</text>
    </g>`;
}

const japaneseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 620" role="img" aria-labelledby="title description">
  <title id="title">Octestra task lifecycle</title>
  <desc id="description">AI Task Status moves from Todo through Ready, In Progress, Validation, Human Review, and Done. Validation may be skipped. Implementation or validation failures move the task to Blocked, from which a human can return it to Ready.</desc>
  <style>
    :root {
      color-scheme: light dark;
    }

    .background {
      fill: #ffffff;
    }

    text {
      fill: #1f2328;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif;
    }

    .node rect {
      fill: #f6f8fa;
      stroke: #8c959f;
      stroke-width: 2;
    }

    .node text {
      font-size: 22px;
      font-weight: 600;
      text-anchor: middle;
      dominant-baseline: middle;
    }

    .edge {
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .human {
      stroke: #0969da;
    }

    .shared {
      stroke: #57606a;
    }

    .agent {
      stroke: #8250df;
    }

    .failure {
      stroke: #cf222e;
    }

    .retry {
      stroke: #1a7f37;
    }

    .label {
      font-size: 16px;
      text-anchor: middle;
    }

    .label-background {
      fill: #ffffff;
      opacity: 0.96;
    }

    .start {
      fill: #8c959f;
    }

    #arrow-human path {
      fill: #0969da;
    }

    #arrow-shared path {
      fill: #57606a;
    }

    #arrow-agent path {
      fill: #8250df;
    }

    #arrow-failure path {
      fill: #cf222e;
    }

    #arrow-retry path {
      fill: #1a7f37;
    }

    @media (prefers-color-scheme: dark) {
      .background,
      .label-background {
        fill: #0d1117;
      }

      text {
        fill: #e6edf3;
      }

      .node rect {
        fill: #161b22;
        stroke: #6e7681;
      }

      .human {
        stroke: #58a6ff;
      }

      .shared {
        stroke: #8c959f;
      }

      .agent {
        stroke: #bc8cff;
      }

      .failure {
        stroke: #ff7b72;
      }

      .retry {
        stroke: #56d364;
      }

      .start {
        fill: #6e7681;
      }

      #arrow-human path {
        fill: #58a6ff;
      }

      #arrow-shared path {
        fill: #8c959f;
      }

      #arrow-agent path {
        fill: #bc8cff;
      }

      #arrow-failure path {
        fill: #ff7b72;
      }

      #arrow-retry path {
        fill: #56d364;
      }
    }
  </style>

  <defs>
    <marker id="arrow-human" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" />
    </marker>
    <marker id="arrow-shared" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" />
    </marker>
    <marker id="arrow-agent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" />
    </marker>
    <marker id="arrow-failure" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" />
    </marker>
    <marker id="arrow-retry" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" />
    </marker>
  </defs>

  <rect class="background" width="1600" height="620" />

  <circle class="start" cx="30" cy="268" r="8" />
  <path class="edge human" d="M 38 268 H 80" marker-end="url(#arrow-human)" />
  <text class="label" x="66" y="214">task issue 作成</text>

  <path class="edge shared" d="M 230 268 H 320" marker-end="url(#arrow-shared)" />
  <text class="label" x="275" y="204">
    <tspan x="275">人間／AI エージェント</tspan>
    <tspan x="275" dy="20">triage して実行可能と判断</tspan>
  </text>

  <path class="edge shared" d="M 470 268 H 560" marker-end="url(#arrow-shared)" />
  <text class="label" x="515" y="204">
    <tspan x="515">人間／AI エージェント</tspan>
    <tspan x="515" dy="20">実装対象の task を選択</tspan>
  </text>

  <path class="edge agent" d="M 750 268 H 850" marker-end="url(#arrow-agent)" />
  <text class="label" x="800" y="184">
    <tspan x="800">実装エージェント</tspan>
    <tspan x="800" dy="20">実装・push・PR 作成</tspan>
  </text>

  <path class="edge agent" d="M 1040 268 H 1130" marker-end="url(#arrow-agent)" />
  <text class="label" x="1085" y="184">
    <tspan x="1085">検証エージェント</tspan>
    <tspan x="1085" dy="20">passed を報告</tspan>
  </text>

  <path class="edge human" d="M 1330 268 H 1420" marker-end="url(#arrow-human)" />
  <text class="label" x="1375" y="204">
    <tspan x="1375">人間</tspan>
    <tspan x="1375" dy="20">レビュー・マージ</tspan>
  </text>

  <path class="edge agent" d="M 655 230 C 655 125, 760 82, 850 82 H 1090 C 1170 82, 1230 140, 1230 230" marker-end="url(#arrow-agent)" />
  <rect class="label-background" x="787" y="47" width="356" height="54" rx="8" />
  <text class="label" x="965" y="68">
    <tspan x="965">実装エージェントが PR 作成</tspan>
    <tspan x="965" dy="20">Octestra が検証を省略してレビューを依頼</tspan>
  </text>

  <path class="edge failure" d="M 655 306 C 655 370, 735 390, 790 455" marker-end="url(#arrow-failure)" />
  <text class="label" x="650" y="376">
    <tspan x="650">実装／workflow 失敗</tspan>
    <tspan x="650" dy="20">Octestra が Issue に記録</tspan>
  </text>

  <path class="edge failure" d="M 945 306 C 945 370, 905 405, 885 455" marker-end="url(#arrow-failure)" />
  <text class="label" x="1040" y="376">
    <tspan x="1040">検証が failed／エラー</tspan>
    <tspan x="1040" dy="20">Octestra が Issue に記録</tspan>
  </text>

  <path class="edge retry" d="M 720 493 C 610 565, 395 565, 395 306" marker-end="url(#arrow-retry)" />
  <text class="label" x="565" y="565">人間が問題を解消して再試行</text>

  ${nodes.map(renderNode).join("")}
</svg>
`;

const englishReplacements = [
  ["人間／AI エージェント", "Human / AI agent"],
  ["人間が問題を解消して再試行", "Human resolves the problem and retries"],
  ["実装エージェントが PR 作成", "Implementation agent creates PR"],
  ["Octestra が検証を省略してレビューを依頼", "Octestra skips validation and requests review"],
  ["task issue 作成", "Create task issue"],
  ["triage して実行可能と判断", "Triage and mark ready"],
  ["実装対象の task を選択", "Pick a task to implement"],
  ["実装エージェント", "Implementation agent"],
  ["実装・push・PR 作成", "Implement · push · create PR"],
  ["検証エージェント", "Validation agent"],
  ["passed を報告", "Report passed"],
  ["人間", "Human"],
  ["レビュー・マージ", "Review · merge"],
  ["実装／workflow 失敗", "Implementation / workflow fails"],
  ["Octestra が Issue に記録", "Octestra records the failure on the issue"],
  ["検証が failed／エラー", "Validation fails / errors"],
];

const englishSvg = englishReplacements.reduce(
  (translated, [japanese, english]) => translated.replaceAll(japanese, english),
  japaneseSvg,
);

writeFileSync(japaneseOutput, japaneseSvg);
writeFileSync(englishOutput, englishSvg);
console.log(`Wrote ${japaneseOutput}`);
console.log(`Wrote ${englishOutput}`);
