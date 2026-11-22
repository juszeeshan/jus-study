
/* ============================================================
   JUS EXAM STUDY — CLEAN FRONTEND
   File: app.js

   INPUT:
   1. QUE       = Original question paper PDF
   2. ANSBOOK   = Questions with answers PDF

   LEFT  = Original QUE question paper
   RIGHT = Extracted questions and answer sheet

   No separate answer key required.
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = id => document.getElementById(id);

const BACKEND_URL =
  "https://script.google.com/macros/s/AKfycbw4wjke1ePGkZqrDhvsjrMqw-mZQxz2HfoXoMjKfsYSPlo0Kx_bXfPatVDXpW4LFAw0/exec";

const DRAFT_KEY = "jusExamStudyDraftV2";
const HISTORY_KEY = "jusExamStudyHistoryV1";

const state = {
  questions: [],
  answers: {},
  questionText: "",
  questionFileName: "",
  answerBookFileName: ""
};

let questionPreviewUrl = null;

/* ============================================================
   HELPERS
   ============================================================ */

function notify(message) {
  $("status").textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function normalizeAnswer(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[.,;:!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function saveDraft() {
  const data = {
    questions: state.questions,
    answers: state.answers,
    studentName: $("studentName").value,
    studentEmail: $("studentEmail").value
  };

  localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
}

function restoreDraft() {
  try {
    const data = JSON.parse(
      localStorage.getItem(DRAFT_KEY) || "null"
    );

    if (!data) return;

    state.questions = data.questions || [];
    state.answers = data.answers || {};

    $("studentName").value = data.studentName || "";
    $("studentEmail").value = data.studentEmail || "";

    renderAll();

    $("evaluateBtn").disabled = !state.questions.length;
  } catch (error) {
    console.error(error);
  }
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

/* ============================================================
   PDF READING — PRESERVE LINES AND OPTION SEPARATION
   ============================================================ */

async function readPdf(file) {
  const buffer = await file.arrayBuffer();

  const pdf = await pdfjsLib.getDocument({
    data: buffer
  }).promise;

  const pages = [];
  let fullText = "";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();

    const items = content.items
      .filter(item => item.str && item.str.trim())
      .map(item => ({
        text: item.str.trim(),
        x: item.transform[4],
        y: item.transform[5]
      }));

    items.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 3) {
        return b.y - a.y;
      }
      return a.x - b.x;
    });

    const lines = [];

    for (const item of items) {
      let line = lines.find(
        row => Math.abs(row.y - item.y) < 3
      );

      if (!line) {
        line = {
          y: item.y,
          items: []
        };
        lines.push(line);
      }

      line.items.push(item);
    }

    lines.sort((a, b) => b.y - a.y);

    const pageLines = lines.map(line => {
      line.items.sort((a, b) => a.x - b.x);

      return line.items
        .map(item => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }).filter(Boolean);

    pages.push(pageLines);
    fullText += pageLines.join("\n") + "\n\n";
  }

  return {
    text: fullText,
    pages,
    lines: pages.flat()
  };
}

/* ============================================================
   ORIGINAL QUESTION PAPER PREVIEW

   IMPORTANT:
   Only QUE is displayed on the left.
   ANSBOOK is NEVER displayed here.
   ============================================================ */

function showQuestionPaper(file) {
  if (!file) return;

  if (questionPreviewUrl) {
    URL.revokeObjectURL(questionPreviewUrl);
  }

  questionPreviewUrl = URL.createObjectURL(file);

  $("paperPreview").innerHTML = `
    <iframe
      title="Original Question Paper"
      src="${questionPreviewUrl}"
      style="width:100%;height:100%;border:0">
    </iframe>
  `;
}

/* ============================================================
   QUESTION SECTION DETECTION
   ============================================================ */

function detectSection(line) {
  const text = line.toLowerCase();

  if (
    /multiple choice questions|multiple choice|choose the correct|select the correct|mcq/.test(text)
  ) {
    return "Multiple Choice";
  }

  if (
    /fill in the blanks|fill in the blank|complete the blanks/.test(text)
  ) {
    return "Fill in the Blanks";
  }

  if (
    /true or false|state whether true or false/.test(text)
  ) {
    return "True / False";
  }

  if (
    /short answer questions|long answer questions|answer the following|essay questions/.test(text)
  ) {
    return "Question and Answer";
  }

  return "";
}

function detectSubject(line) {
  const match = line.match(
    /^(?:subject\s*[:.-]\s*|subject\s+\d+\s*[:.-]\s*)(.+)$/i
  );

  return match ? match[1].trim() : "";
}

/* ============================================================
   QUESTION NUMBER DETECTION
   ============================================================ */

function getQuestionNumber(line) {
  const match = line.match(
    /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.)]\s*(.*)$/i
  );

  if (!match) return null;

  return {
    number: match[1],
    text: match[2] || ""
  };
}

/* ============================================================
   MCQ OPTION DETECTION

   Handles:
   A. Option
   A) Option
   (A) Option
   A - Option

   Also handles multiple options on the same line.
   ============================================================ */

function extractOptions(textLines) {
  const options = [];
  const remainingLines = [];

  const marker =
    /(?:^|\s)(?:\(([A-D])\)|([A-D])\s*[).:-])\s*/gi;

  for (const originalLine of textLines) {
    const line = originalLine.trim();

    const matches = [];
    let match;

    while ((match = marker.exec(line)) !== null) {
      matches.push({
        index: match.index,
        end: marker.lastIndex,
        key: (match[1] || match[2]).toUpperCase()
      });
    }

    if (!matches.length) {
      remainingLines.push(line);
      continue;
    }

    const prefix = line.slice(0, matches[0].index).trim();

    if (prefix) remainingLines.push(prefix);

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].end;
      const end = i + 1 < matches.length
        ? matches[i + 1].index
        : line.length;

      const optionText = line.slice(start, end).trim();

      if (optionText) {
        options.push({
          key: matches[i].key,
          text: optionText
        });
      }
    }
  }

  return {
    options,
    questionLines: remainingLines
  };
}

/* ============================================================
   QUESTION TYPE
   ============================================================ */

function classifyQuestion(text, options, section) {
  if (options.length >= 2 || section === "Multiple Choice") {
    return "mcq";
  }

  if (section === "Fill in the Blanks") {
    return "fill";
  }

  if (section === "True / False") {
    return "truefalse";
  }

  if (/_{2,}|\.{3,}/.test(text)) {
    return "fill";
  }

  return "descriptive";
}

/* ============================================================
   PARSE QUESTION PAPER

   Original question numbers are preserved.
   Option lines are separated from question text.
   ============================================================ */

function parseQuestionPaper(lines) {
  const questions = [];

  let subject = "General";
  let section = "";

  let current = null;

  const occurrences = {};

  function finishQuestion() {
    if (!current) return;

    const extracted = extractOptions(current.lines);

    const questionText = extracted.questionLines
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const options = extracted.options;

    const type = classifyQuestion(
      questionText,
      options,
      current.section
    );

    const base = `${current.subject}::${current.number}`;

    occurrences[base] = (occurrences[base] || 0) + 1;

    const markMatch = questionText.match(
      /\(\s*(\d+(?:\.\d+)?)\s*marks?\s*\)/i
    );

    questions.push({
      id: `${base}::${occurrences[base]}`,
      number: current.number,
      subject: current.subject,
      section: current.section,
      text: questionText,
      type,
      options,
      marks: markMatch ? Number(markMatch[1]) : 1,
      referenceAnswer: "",
      answerSource: ""
    });

    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    const detectedSubject = detectSubject(line);

    if (detectedSubject) {
      finishQuestion();
      subject = detectedSubject;
      section = "";
      continue;
    }

    const detectedSection = detectSection(line);

    if (detectedSection && line.length < 130) {
      finishQuestion();
      section = detectedSection;
      continue;
    }

    const number = getQuestionNumber(line);

    if (number) {
      finishQuestion();

      current = {
        number: number.number,
        subject,
        section,
        lines: [number.text]
      };

      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  finishQuestion();

  return questions;
}

/* ============================================================
   PARSE ANSWERS FROM ANSBOOK

   Supports explicit labels such as:
   Answer:
   Ans:
   Correct Answer:
   Reference Answer:

   Does not invent answers when formatting is ambiguous.
   ============================================================ */

function extractAnswerBlocks(lines) {
  const answerMap = {};

  let currentNumber = null;
  let collectingAnswer = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    const question = getQuestionNumber(line);

    if (question) {
      currentNumber = question.number;
      collectingAnswer = false;
      continue;
    }

    const answerMatch = line.match(
      /^(?:correct\s+answer|reference\s+answer|answer|ans)\s*[:.-]\s*(.*)$/i
    );

    if (answerMatch && currentNumber) {
      const answer = answerMatch[1].trim();

      if (!answerMap[currentNumber]) {
        answerMap[currentNumber] = [];
      }

      if (answer) {
        answerMap[currentNumber].push(answer);
      }

      collectingAnswer = true;
      continue;
    }

    if (collectingAnswer && currentNumber) {
      if (!answerMap[currentNumber]) {
        answerMap[currentNumber] = [];
      }

      const previous = answerMap[currentNumber].length - 1;

      if (previous >= 0) {
        answerMap[currentNumber][previous] += " " + line;
      }
    }
  }

  return answerMap;
}

/* ============================================================
   MATCH ANSBOOK ANSWERS TO QUESTION PAPER
   ============================================================ */

function attachReferenceAnswers(questions, answerMap) {
  const used = {};

  for (const question of questions) {
    const candidates = answerMap[question.number] || [];

    if (!candidates.length) continue;

    const index = used[question.number] || 0;

    if (candidates.length === 1) {
      question.referenceAnswer = candidates[0];
    } else if (candidates[index]) {
      question.referenceAnswer = candidates[index];
    }

    if (question.referenceAnswer) {
      question.answerSource = "ANSBOOK";
    }

    used[question.number] = index + 1;
  }
}

/* ============================================================
   SUBJECT FILTER
   ============================================================ */

function renderSubjectFilter() {
  const select = $("subjectFilter");
  const previous = select.value || "All";

  const subjects = [
    ...new Set(state.questions.map(q => q.subject))
  ];

  select.innerHTML =
    `<option value="All">All subjects</option>` +
    subjects.map(subject => `
      <option value="${escapeHtml(subject)}">
        ${escapeHtml(subject)}
      </option>
    `).join("");

  select.value = subjects.includes(previous) ? previous : "All";
}

/* ============================================================
   RENDER QUESTIONS
   ============================================================ */

function renderQuestions() {
  const filter = $("subjectFilter").value || "All";

  const questions = state.questions.filter(q =>
    filter === "All" || q.subject === filter
  );

  if (!questions.length) {
    $("questionList").innerHTML =
      "<p>No questions extracted.</p>";
    return;
  }

  $("questionList").innerHTML = questions.map(q => {
    const answer = state.answers[q.id] || "";

    let answerHtml = "";

    if (q.type === "mcq") {
      answerHtml = q.options.map(option => `
        <label class="option-row">
          <input
            type="radio"
            name="answer-${escapeHtml(q.id)}"
            data-answer="${escapeHtml(q.id)}"
            value="${escapeHtml(option.key)}"
            ${answer === option.key ? "checked" : ""}
          >
          <span>
            <strong>${escapeHtml(option.key)}.</strong>
            ${escapeHtml(option.text)}
          </span>
        </label>
      `).join("");

      if (!q.options.length) {
        answerHtml = `
          <p class="warning">
            Options could not be detected. Use the pencil icon to correct them.
          </p>
        `;
      }

    } else if (q.type === "truefalse") {
      answerHtml = ["True", "False"].map(value => `
        <label class="option-row">
          <input
            type="radio"
            name="answer-${escapeHtml(q.id)}"
            data-answer="${escapeHtml(q.id)}"
            value="${value}"
            ${answer === value ? "checked" : ""}
          >
          ${value}
        </label>
      `).join("");

    } else if (q.type === "fill") {
      answerHtml = `
        <input
          class="answer-input"
          type="text"
          data-answer="${escapeHtml(q.id)}"
          value="${escapeHtml(answer)}"
          placeholder="Write your answer"
        >
      `;

    } else {
      answerHtml = `
        <textarea
          class="answer-input"
          data-answer="${escapeHtml(q.id)}"
          placeholder="Write your answer"
        >${escapeHtml(answer)}</textarea>
      `;
    }

    return `
      <article class="question-card">

        <button
          class="edit-pencil"
          type="button"
          data-edit="${escapeHtml(q.id)}"
          title="Edit question"
        >✎</button>

        <div class="question-title">
          <strong>
            ${escapeHtml(q.subject)} — Question ${escapeHtml(q.number)}
          </strong>
          <span>
            ${escapeHtml(q.section || q.type)}
            · ${escapeHtml(q.marks)} mark(s)
          </span>
        </div>

        <p class="question-text">
          ${escapeHtml(q.text)}
        </p>

        <div class="answer-area">
          <strong>Your answer</strong>
          ${answerHtml}
        </div>

        <div
          class="question-editor"
          id="editor-${escapeHtml(q.id)}"
          hidden
        >

          <label>Question text
            <textarea data-field="text" data-id="${escapeHtml(q.id)}">${escapeHtml(q.text)}</textarea>
          </label>

          <label>Question type
            <select data-field="type" data-id="${escapeHtml(q.id)}">
              <option value="mcq" ${q.type === "mcq" ? "selected" : ""}>MCQ</option>
              <option value="fill" ${q.type === "fill" ? "selected" : ""}>Fill in the blanks</option>
              <option value="truefalse" ${q.type === "truefalse" ? "selected" : ""}>True / False</option>
              <option value="descriptive" ${q.type === "descriptive" ? "selected" : ""}>Question and Answer</option>
            </select>
          </label>

          <label>Options — one per line
            <textarea data-field="options" data-id="${escapeHtml(q.id)}">${escapeHtml(
              q.options.map(o => `${o.key}. ${o.text}`).join("\n")
            )}</textarea>
          </label>

          <label>Reference answer
            <textarea data-field="referenceAnswer" data-id="${escapeHtml(q.id)}">${escapeHtml(q.referenceAnswer)}</textarea>
          </label>

          <label>Marks
            <input type="number" min="0" step="0.5"
              data-field="marks" data-id="${escapeHtml(q.id)}"
              value="${escapeHtml(q.marks)}">
          </label>

          <div class="editor-actions">
            <button type="button" data-save="${escapeHtml(q.id)}">
              Save changes
            </button>

            <button type="button" class="danger"
              data-delete="${escapeHtml(q.id)}">
              Delete
            </button>
          </div>
        </div>

      </article>
    `;
  }).join("");

  bindQuestionEvents();
}

/* ============================================================
   QUESTION EVENTS
   ============================================================ */

function bindQuestionEvents() {
  $("questionList").querySelectorAll("[data-answer]").forEach(input => {
    const save = () => {
      state.answers[input.dataset.answer] = input.value;
      saveDraft();
    };

    input.addEventListener("input", save);
    input.addEventListener("change", save);
  });

  $("questionList").querySelectorAll("[data-edit]").forEach(button => {
    button.addEventListener("click", () => {
      const editor = $(`editor-${button.dataset.edit}`);
      editor.hidden = !editor.hidden;
    });
  });

  $("questionList").querySelectorAll("[data-save]").forEach(button => {
    button.addEventListener("click", () => {
      saveQuestion(button.dataset.save);
    });
  });

  $("questionList").querySelectorAll("[data-delete]").forEach(button => {
    button.addEventListener("click", () => {
      deleteQuestion(button.dataset.delete);
    });
  });
}

function saveQuestion(id) {
  const q = state.questions.find(item => item.id === id);
  if (!q) return;

  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)
    .forEach(field => {
      const key = field.dataset.field;

      if (key === "text") q.text = field.value.trim();
      if (key === "type") q.type = field.value;
      if (key === "referenceAnswer") {
        q.referenceAnswer = field.value.trim();
      }
      if (key === "marks") q.marks = Number(field.value) || 0;

      if (key === "options") {
        q.options = field.value.split(/\r?\n/)
          .map(line => {
            const match = line.match(
              /^\s*(?:\(([A-D])\)|([A-D])\s*[).:-])\s*(.+)$/i
            );

            if (!match) return null;

            return {
              key: (match[1] || match[2]).toUpperCase(),
              text: match[3].trim()
            };
          })
          .filter(Boolean);
      }
    });

  saveDraft();
  renderAll();
  notify("Question updated.");
}

function deleteQuestion(id) {
  if (!confirm("Delete this question?")) return;

  state.questions = state.questions.filter(q => q.id !== id);
  delete state.answers[id];

  saveDraft();
  renderAll();
}

function addQuestion() {
  const number = String(
    Math.max(0, ...state.questions.map(q => Number(q.number) || 0)) + 1
  );

  const subject = $("subjectFilter").value === "All"
    ? "General"
    : $("subjectFilter").value;

  state.questions.push({
    id: `manual-${Date.now()}`,
    number,
    subject,
    section: "",
    text: "New question",
    type: "descriptive",
    options: [],
    marks: 1,
    referenceAnswer: "",
    answerSource: ""
  });

  saveDraft();
  renderAll();
}

/* ============================================================
   REFERENCE ANSWERS
   ============================================================ */

function renderReferences() {
  const found = state.questions.filter(q => q.referenceAnswer);

  $("referenceList").innerHTML = found.length
    ? found.map(q => `
      <div class="reference-card">
        <strong>${escapeHtml(q.subject)} — Q${escapeHtml(q.number)}</strong>
        <p>${escapeHtml(q.referenceAnswer)}</p>
      </div>
    `).join("")
    : "<p>No labelled reference answers detected. You can enter them using the pencil icon.</p>";
}

function renderAll() {
  renderSubjectFilter();
  renderQuestions();
  renderReferences();
}

/* ============================================================
   EVALUATION
   ============================================================ */

function expectedMcqKey(q) {
  const expected = String(q.referenceAnswer || "").trim();

  const letter = expected.match(
    /^(?:answer\s*[:.-]?\s*)?([A-D])(?:[).]|\s|$)/i
  );

  if (letter) return letter[1].toUpperCase();

  const option = q.options.find(o =>
    normalizeAnswer(o.text) === normalizeAnswer(expected)
  );

  return option ? option.key : "";
}

function evaluateQuestion(q) {
  const given = String(state.answers[q.id] || "").trim();
  const expected = String(q.referenceAnswer || "").trim();

  if (!expected) {
    return {
      result: "Manual review",
      score: null,
      given,
      expected
    };
  }

  let correct = false;

  if (q.type === "mcq") {
    const key = expectedMcqKey(q);

    const selected = q.options.find(o => o.key === given);

    correct =
      (key && given.toUpperCase() === key) ||
      (selected &&
        normalizeAnswer(selected.text) === normalizeAnswer(expected));

  } else if (q.type === "fill" || q.type === "truefalse") {
    correct =
      normalizeAnswer(given) === normalizeAnswer(expected);

  } else {
    return {
      result: "Manual review",
      score: null,
      given,
      expected
    };
  }

  return {
    result: correct ? "Correct" : "Incorrect",
    score: correct ? Number(q.marks) : 0,
    given,
    expected
  };
}

function evaluatePaper() {
  if (!state.questions.length) {
    notify("Upload and process your PDFs first.");
    return;
  }

  const rows = state.questions.map(q => ({
    question: q,
    ...evaluateQuestion(q)
  }));

  const earned = rows.reduce(
    (sum, row) => sum + (row.score ?? 0), 0
  );

  const possible = rows.reduce(
    (sum, row) => sum + Number(row.question.marks || 0), 0
  );

  const manual = rows.filter(row => row.score === null).length;

  const result = {
    rows,
    earned,
    possible,
    manual,
    percentage: possible
      ? Math.round(earned / possible * 100)
      : 0
  };

  showResult(result);
  recordHistory(result);
  submitToBackend(result);
}

/* ============================================================
   RESULT MODAL
   ============================================================ */

function showResult(result) {
  $("resultContent").innerHTML = `
    <div class="result-summary">
      <h3>${result.earned} / ${result.possible}</h3>
      <p>${result.percentage}% automatically evaluated</p>
      <p>${result.manual} question(s) need manual review.</p>
    </div>

    ${result.rows.map(row => `
      <div class="result-row">
        <strong>
          ${escapeHtml(row.question.subject)} —
          Q${escapeHtml(row.question.number)}
        </strong>

        <span>${escapeHtml(row.result)}</span>

        <p>Your answer: ${escapeHtml(row.given || "Not answered")}</p>
        <p>Reference: ${escapeHtml(row.expected || "Not available")}</p>
      </div>
    `).join("")}
  `;

  $("resultModal").hidden = false;
}

/* ============================================================
   HISTORY
   ============================================================ */

function recordHistory(result) {
  const history = getHistory();

  history.unshift({
    date: new Date().toLocaleString(),
    student: $("studentName").value,
    email: $("studentEmail").value,
    earned: result.earned,
    possible: result.possible,
    percentage: result.percentage,
    manual: result.manual,
    count: state.questions.length
  });

  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(history.slice(0, 100))
  );
}

function renderHistory() {
  const history = getHistory();

  $("historyList").innerHTML = history.length
    ? history.map(item => `
      <div class="history-card">
        <strong>${escapeHtml(item.date)}</strong>
        <p>${escapeHtml(item.student || "Student")} —
          ${item.earned}/${item.possible}
          (${item.percentage}%)</p>
      </div>
    `).join("")
    : "<p>No practice history yet.</p>";
}

/* ============================================================
   GOOGLE SHEETS BACKEND
   ============================================================ */

async function submitToBackend(result) {
  const payload = {
    action: "submitExam",
    studentName: $("studentName").value.trim(),
    email: $("studentEmail").value.trim(),
    questionPaper: state.questionFileName,
    answerKey: "",
    answerBook: state.answerBookFileName,
    date: new Date().toISOString(),
    earned: result.earned,
    possible: result.possible,
    percentage: result.percentage,
    manualReview: result.manual,

    answers: result.rows.map(row => ({
      number: row.question.number,
      subject: row.question.subject,
      question: row.question.text,
      studentAnswer: row.given,
      referenceAnswer: row.expected,
      result: row.result,
      marks: row.score,
      maximumMarks: row.question.marks
    }))
  };

  try {
    await fetch(BACKEND_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    notify("Evaluation completed. Submission request sent to Google Sheets.");

  } catch (error) {
    console.error(error);
    notify("Evaluation completed locally. Backend submission failed.");
  }
}

/* ============================================================
   CSV EXPORT
   ============================================================ */

function exportCsv() {
  if (!state.questions.length) {
    notify("No questions to export.");
    return;
  }

  const rows = [[
    "Subject",
    "Question Number",
    "Question",
    "Type",
    "Student Answer",
    "Reference Answer",
    "Result",
    "Marks",
    "Maximum Marks"
  ]];

  state.questions.forEach(q => {
    const result = evaluateQuestion(q);

    rows.push([
      q.subject,
      q.number,
      q.text,
      q.type,
      result.given,
      result.expected,
      result.result,
      result.score ?? "",
      q.marks
    ]);
  });

  const csv = rows.map(row =>
    row.map(value =>
      `"${String(value ?? "").replace(/"/g, '""')}"`
    ).join(",")
  ).join("\r\n");

  const blob = new Blob(
    [csv],
    { type: "text/csv;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "Jus-Exam-Study.csv";
  link.click();

  URL.revokeObjectURL(url);
}

/* ============================================================
   PROCESS QUE + ANSBOOK

   QUE goes to left preview.
   ANSBOOK is only used for reference answers.
   ============================================================ */

async function processPdfs() {
  const que = $("questionPdf").files[0];
  const book = $("answerBookPdf").files[0];

  if (!que) {
    notify("Please select your original question paper PDF (QUE).");
    return;
  }

  $("processBtn").disabled = true;
  $("processBtn").textContent = "Processing...";

  try {
    state.questions = [];
    state.answers = {};

    state.questionFileName = que.name;
    state.answerBookFileName = book ? book.name : "";

    /* 1. Read original question paper */
    notify("Reading original question paper...");

    const queData = await readPdf(que);

    state.questionText = queData.text;

    /* 2. Display ONLY original question paper on left */
    showQuestionPaper(que);

    /* 3. Extract questions and options from QUE */
    notify("Extracting questions and MCQ options...");

    state.questions = parseQuestionPaper(queData.lines);

    /* 4. Read ANSBOOK only for answers */
    if (book) {
      notify("Reading questions-with-answers document...");

      const bookData = await readPdf(book);

      const answerMap = extractAnswerBlocks(bookData.lines);

      attachReferenceAnswers(state.questions, answerMap);
    }

    if (!state.questions.length) {
      notify(
        "No numbered questions detected. This PDF may be scanned or use an unsupported numbering format."
      );
      return;
    }

    renderAll();

    $("evaluateBtn").disabled = false;

    saveDraft();

    const mcqCount = state.questions.filter(
      q => q.type === "mcq"
    ).length;

    const missingOptions = state.questions.filter(
      q => q.type === "mcq" && !q.options.length
    ).length;

    const referenceCount = state.questions.filter(
      q => q.referenceAnswer
    ).length;

    notify(
      `${state.questions.length} questions extracted. ` +
      `${mcqCount} MCQs. ` +
      `${missingOptions} MCQs need option correction. ` +
      `${referenceCount} labelled reference answers found.`
    );

  } catch (error) {
    console.error(error);
    notify("PDF processing failed. Check the PDF and try again.");
  } finally {
    $("processBtn").disabled = false;
    $("processBtn").textContent = "Process PDFs";
  }
}

/* ============================================================
   FILE LABELS
   ============================================================ */

function connectFileInput(inputId, labelId) {
  const input = $(inputId);
  const label = $(labelId);

  if (!input || !label) return;

  input.addEventListener("change", () => {
    label.textContent = input.files[0]
      ? input.files[0].name
      : "No file selected";
  });
}

/* ============================================================
   EVENTS
   ============================================================ */

$("processBtn").addEventListener("click", processPdfs);

$("addBtn").addEventListener("click", addQuestion);

$("evaluateBtn").addEventListener("click", evaluatePaper);

$("exportBtn").addEventListener("click", exportCsv);

$("subjectFilter").addEventListener("change", renderQuestions);

$("studentName").addEventListener("input", saveDraft);

$("studentEmail").addEventListener("input", saveDraft);

$("historyBtn").addEventListener("click", () => {
  $("historySection").hidden = false;
  renderHistory();
});

$("closeHistoryBtn").addEventListener("click", () => {
  $("historySection").hidden = true;
});

$("clearHistoryBtn").addEventListener("click", () => {
  if (!confirm("Clear practice history?")) return;

  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

$("closeResultBtn").addEventListener("click", () => {
  $("resultModal").hidden = true;
});

$("resultModal").addEventListener("click", event => {
  if (event.target === $("resultModal")) {
    $("resultModal").hidden = true;
  }
});

$("printBtn").addEventListener("click", () => {
  window.print();
});

connectFileInput("questionPdf", "questionName");
connectFileInput("answerBookPdf", "answerBookName");

/* ============================================================
   STARTUP
   ============================================================ */

$("resultModal").hidden = true;
$("historySection").hidden = true;
$("evaluateBtn").disabled = true;

restoreDraft();
renderHistory();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(error => console.warn(error));
  });
}
