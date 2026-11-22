
/* =========================================================
   JUS EXAM STUDY
   Fresh basic frontend
   File: app.js
   ========================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* PASTE YOUR DEPLOYED GOOGLE APPS SCRIPT URL HERE */
const BACKEND_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";

const $ = id => document.getElementById(id);

const DRAFT_KEY = "jusExamStudyDraftV1";
const HISTORY_KEY = "jusExamStudyHistoryV1";

const state = {
  questions: [],
  answers: {},
  questionText: "",
  questionFileName: "",
  answerFileName: "",
  answerBookFileName: ""
};

let previewUrl = null;

/* ---------------- HELPERS ---------------- */

function status(message) {
  $("status").textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^\s*(answer|ans)\s*[:.-]\s*/i, "")
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
    const data = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!data) return;

    state.questions = Array.isArray(data.questions) ? data.questions : [];
    state.answers = data.answers || {};

    $("studentName").value = data.studentName || "";
    $("studentEmail").value = data.studentEmail || "";

    renderAll();
    $("evaluateBtn").disabled = state.questions.length === 0;
  } catch (error) {
    console.warn("Could not restore draft", error);
  }
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

/* ---------------- PDF READING ---------------- */

async function readPdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

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
      if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
      return a.x - b.x;
    });

    const lines = [];

    for (const item of items) {
      let line = lines.find(row => Math.abs(row.y - item.y) < 3);

      if (!line) {
        line = { y: item.y, items: [] };
        lines.push(line);
      }

      line.items.push(item);
    }

    lines.sort((a, b) => b.y - a.y);

    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      fullText += line.items.map(item => item.text).join(" ") + "\n";
    }

    fullText += "\n";
  }

  return fullText;
}

function showPdfPreview(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);

  previewUrl = URL.createObjectURL(file);

  $("paperPreview").innerHTML =
    `<iframe title="Question paper PDF" src="${previewUrl}"></iframe>`;
}

/* ---------------- QUESTION PARSING ---------------- */

function sectionFromText(text) {
  const t = text.toLowerCase();

  if (/multiple choice|choose the correct|select the correct|mcq/.test(t)) {
    return "Multiple Choice";
  }

  if (/fill in the blanks|fill in the blank|complete the following/.test(t)) {
    return "Fill in the Blanks";
  }

  if (/true or false|state true or false/.test(t)) {
    return "True / False";
  }

  if (/short answer|long answer|answer the following|essay questions/.test(t)) {
    return "Question and Answer";
  }

  return "";
}

function parseOptions(text) {
  const result = [];
  const regex = /(?:^|\s)(?:\(([A-D])\)|([A-D])[).])\s*(.*?)(?=(?:\s+\([A-D]\)|\s+[A-D][).])|$)/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const key = (match[1] || match[2] || "").toUpperCase();
    const value = (match[3] || "").trim();

    if (key && value) result.push({ key, text: value });
  }

  return result;
}

function getQuestionType(text, options, section) {
  if (options.length >= 2 || section === "Multiple Choice") return "mcq";

  if (section === "Fill in the Blanks" ||
      /fill in the blank|complete the sentence/i.test(text)) {
    return "fill";
  }

  if (section === "True / False" ||
      /true or false/i.test(text)) {
    return "truefalse";
  }

  return "descriptive";
}

function parseQuestions(text) {
  const lines = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const questions = [];
  let subject = "General";
  let section = "";
  let current = null;

  const occurrences = {};

  function finish() {
    if (!current) return;

    current.text = current.text.replace(/\s+/g, " ").trim();

    if (current.text.length > 1) {
      current.options = parseOptions(current.text);
      current.type = getQuestionType(
        current.text,
        current.options,
        current.section
      );

      const base = `${current.subject}::${current.number}`;
      occurrences[base] = (occurrences[base] || 0) + 1;

      current.id = `${base}::${occurrences[base]}`;
      current.marks = 1;
      current.referenceAnswer = "";

      const mark = current.text.match(/\(\s*(\d+(?:\.\d+)?)\s*marks?\s*\)/i);
      if (mark) current.marks = Number(mark[1]);

      current.text = current.text.replace(
        /^\s*(?:Q(?:uestion)?\s*)?\d+\s*[.)-]\s*/i,
        ""
      );

      questions.push(current);
    }

    current = null;
  }

  for (const line of lines) {
    const subjectMatch = line.match(
      /^(?:subject\s*[:.-]\s*|subject\s+\d+\s*[:.-]\s*)(.+)$/i
    );

    if (subjectMatch) {
      finish();
      subject = subjectMatch[1].trim();
      section = "";
      continue;
    }

    const detectedSection = sectionFromText(line);

    if (detectedSection && line.length < 100) {
      section = detectedSection;
      continue;
    }

    const numberMatch = line.match(
      /^(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.)-]\s*(.*)$/i
    );

    if (numberMatch) {
      finish();

      current = {
        number: numberMatch[1],
        subject,
        section,
        text: numberMatch[2] || "",
        options: [],
        type: "descriptive",
        marks: 1,
        referenceAnswer: ""
      };

      continue;
    }

    if (current) current.text += " " + line;
  }

  finish();
  return questions;
}

/* ---------------- ANSWER KEY PARSING ---------------- */

function parseAnswerKey(text) {
  const answerMap = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.trim().match(
      /^(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.):\-]\s*(?:answer\s*[:\-]?\s*)?(.+)$/i
    );

    if (!match) continue;

    const number = match[1];
    const answer = match[2].trim();

    if (!answer) continue;

    if (!answerMap[number]) answerMap[number] = [];
    answerMap[number].push(answer);
  }

  return answerMap;
}

function attachAnswerKey(questions, answerMap) {
  const seen = {};

  for (const q of questions) {
    const answers = answerMap[q.number] || [];
    const index = seen[q.number] || 0;

    if (answers.length === 1) {
      q.referenceAnswer = answers[0];
      q.answerSource = "ANS";
    } else if (answers[index]) {
      q.referenceAnswer = answers[index];
      q.answerSource = "ANS";
    }

    seen[q.number] = index + 1;
  }
}

/* ---------------- COMBINED ANSBOOK ---------------- */

function attachCombinedAnswers(questions, text) {
  const blocks = text.split(
    /(?=^(?:Q(?:uestion)?\s*)?\d{1,3}\s*[.)-])/gim
  );

  for (const q of questions) {
    const block = blocks.find(part => {
      const match = part.match(
        /^(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.)-]/i
      );
      return match && match[1] === q.number;
    });

    if (!block) continue;

    const match = block.match(
      /(?:correct\s+answer|reference\s+answer|answer|ans)\s*[:\-]\s*([\s\S]*?)(?=\n\s*(?:Q(?:uestion)?\s*)?\d+\s*[.)-]|$)/i
    );

    if (match) {
      q.referenceAnswer = match[1].trim().split(/\r?\n/)[0].trim();
      q.answerSource = "ANSBOOK";
    }
  }
}

/* ---------------- SUBJECT FILTER ---------------- */

function updateSubjects() {
  const select = $("subjectFilter");
  const oldValue = select.value || "All";

  const subjects = [...new Set(
    state.questions.map(q => q.subject || "General")
  )];

  select.innerHTML =
    `<option value="All">All subjects</option>` +
    subjects.map(subject =>
      `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`
    ).join("");

  select.value = subjects.includes(oldValue) ? oldValue : "All";
}

/* ---------------- QUESTION RENDERING ---------------- */

function renderQuestions() {
  const filter = $("subjectFilter").value || "All";

  const questions = state.questions.filter(q =>
    filter === "All" || q.subject === filter
  );

  if (!questions.length) {
    $("questionList").innerHTML = "<p>No questions available.</p>";
    return;
  }

  $("questionList").innerHTML = questions.map(q => {
    const answer = state.answers[q.id] || "";

    let inputHtml = "";

    if (q.type === "mcq") {
      inputHtml = (q.options || []).map(option => `
        <label class="option-row">
          <input type="radio"
            name="answer-${escapeHtml(q.id)}"
            value="${escapeHtml(option.key)}"
            data-answer="${escapeHtml(q.id)}"
            ${answer === option.key ? "checked" : ""}>
          <span><strong>${escapeHtml(option.key)}.</strong>
            ${escapeHtml(option.text)}</span>
        </label>
      `).join("");
    } else if (q.type === "truefalse") {
      inputHtml = ["True", "False"].map(value => `
        <label class="option-row">
          <input type="radio"
            name="answer-${escapeHtml(q.id)}"
            value="${value}"
            data-answer="${escapeHtml(q.id)}"
            ${answer === value ? "checked" : ""}>
          ${value}
        </label>
      `).join("");
    } else if (q.type === "fill") {
      inputHtml = `
        <input class="answer-input"
          type="text"
          data-answer="${escapeHtml(q.id)}"
          value="${escapeHtml(answer)}"
          placeholder="Enter your answer">
      `;
    } else {
      inputHtml = `
        <textarea class="answer-input"
          data-answer="${escapeHtml(q.id)}"
          placeholder="Write your answer">${escapeHtml(answer)}</textarea>
      `;
    }

    return `
      <article class="question-card">

        <button class="edit-pencil"
          type="button"
          data-edit="${escapeHtml(q.id)}"
          title="Edit question">✎</button>

        <div class="question-title">
          <strong>${escapeHtml(q.subject)} — Question ${escapeHtml(q.number)}</strong>
          <span>${escapeHtml(q.type)} · ${escapeHtml(q.marks)} mark(s)</span>
        </div>

        <p class="question-text">${escapeHtml(q.text)}</p>

        <div class="answer-area">
          <strong>Your answer</strong>
          ${inputHtml}
        </div>

        <div class="question-editor" id="editor-${escapeHtml(q.id)}" hidden>
          <label>Question
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

          <label>Options (one per line: A. Option)
            <textarea data-field="options" data-id="${escapeHtml(q.id)}">${escapeHtml(
              (q.options || []).map(o => `${o.key}. ${o.text}`).join("\n")
            )}</textarea>
          </label>

          <label>Reference answer
            <textarea data-field="referenceAnswer" data-id="${escapeHtml(q.id)}">${escapeHtml(q.referenceAnswer || "")}</textarea>
          </label>

          <label>Marks
            <input type="number" min="0" step="0.5"
              data-field="marks" data-id="${escapeHtml(q.id)}"
              value="${escapeHtml(q.marks)}">
          </label>

          <div class="editor-actions">
            <button type="button" data-save="${escapeHtml(q.id)}">Save</button>
            <button type="button" class="danger" data-delete="${escapeHtml(q.id)}">Delete</button>
          </div>
        </div>

      </article>
    `;
  }).join("");

  $("questionList").querySelectorAll("[data-answer]").forEach(input => {
    const saveAnswer = () => {
      state.answers[input.dataset.answer] = input.value;
      saveDraft();
    };

    input.addEventListener("input", saveAnswer);
    input.addEventListener("change", saveAnswer);
  });

  $("questionList").querySelectorAll("[data-edit]").forEach(button => {
    button.addEventListener("click", () => {
      const editor = $(`editor-${button.dataset.edit}`);
      editor.hidden = !editor.hidden;
    });
  });

  $("questionList").querySelectorAll("[data-save]").forEach(button => {
    button.addEventListener("click", () => saveQuestion(button.dataset.save));
  });

  $("questionList").querySelectorAll("[data-delete]").forEach(button => {
    button.addEventListener("click", () => deleteQuestion(button.dataset.delete));
  });
}

function saveQuestion(id) {
  const q = state.questions.find(item => item.id === id);
  if (!q) return;

  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach(field => {
    const name = field.dataset.field;

    if (name === "text") q.text = field.value.trim();
    if (name === "type") q.type = field.value;
    if (name === "referenceAnswer") q.referenceAnswer = field.value.trim();
    if (name === "marks") q.marks = Number(field.value) || 0;

    if (name === "options") {
      q.options = field.value.split(/\r?\n/)
        .map(line => {
          const match = line.match(/^\s*([A-D])\s*[.)-]\s*(.+)$/i);
          return match
            ? { key: match[1].toUpperCase(), text: match[2].trim() }
            : null;
        })
        .filter(Boolean);
    }
  });

  saveDraft();
  renderAll();
  status("Question updated.");
}

function deleteQuestion(id) {
  if (!confirm("Delete this question?")) return;

  state.questions = state.questions.filter(q => q.id !== id);
  delete state.answers[id];

  saveDraft();
  renderAll();
  status("Question deleted.");
}

function addQuestion() {
  const highest = Math.max(
    0,
    ...state.questions.map(q => Number(q.number) || 0)
  );

  const number = String(highest + 1);
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
    referenceAnswer: ""
  });

  saveDraft();
  renderAll();
  status("Question added. Use the pencil icon to edit it.");
}

/* ---------------- REFERENCE ANSWERS ---------------- */

function renderReferences() {
  const found = state.questions.filter(q => q.referenceAnswer);

  if (!found.length) {
    $("referenceList").innerHTML = "<p>No reference answers found.</p>";
    return;
  }

  $("referenceList").innerHTML = found.map(q => `
    <div class="reference-card">
      <strong>${escapeHtml(q.subject)} — Q${escapeHtml(q.number)}</strong>
      <p>${escapeHtml(q.referenceAnswer)}</p>
      <small>${escapeHtml(q.answerSource || "Reference answer")}</small>
    </div>
  `).join("");
}

function renderAll() {
  updateSubjects();
  renderQuestions();
  renderReferences();
}

/* ---------------- EVALUATION ---------------- */

function expectedMcqKey(q) {
  const expected = String(q.referenceAnswer || "").trim();

  const match = expected.match(/^(?:answer\s*[:.-]?\s*)?([A-D])(?:[).]|\s|$)/i);
  if (match) return match[1].toUpperCase();

  const option = (q.options || []).find(o =>
    normalize(o.text) === normalize(expected)
  );

  return option ? option.key : "";
}

function evaluateQuestion(q) {
  const given = String(state.answers[q.id] || "").trim();
  const expected = String(q.referenceAnswer || "").trim();

  if (!expected) {
    return { result: "Manual review", score: null, given, expected };
  }

  let correct = false;

  if (q.type === "mcq") {
    const key = expectedMcqKey(q);
    const selected = (q.options || []).find(o => o.key === given);

    correct =
      (key && given.toUpperCase() === key) ||
      (selected && normalize(selected.text) === normalize(expected));
  } else if (q.type === "fill" || q.type === "truefalse") {
    correct = normalize(given) === normalize(expected);
  } else {
    return { result: "Manual review", score: null, given, expected };
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
    status("Please process a question paper first.");
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
    (sum, row) => sum + (Number(row.question.marks) || 0), 0
  );

  const manual = rows.filter(row => row.score === null).length;

  const result = {
    rows,
    earned,
    possible,
    manual,
    percentage: possible ? Math.round(earned / possible * 100) : 0
  };

  showResult(result);
  recordHistory(result);
  submitToBackend(result);
}

/* ---------------- RESULT ---------------- */

function showResult(result) {
  $("resultContent").innerHTML = `
    <div class="result-summary">
      <h3>${result.earned} / ${result.possible}</h3>
      <p>${result.percentage}% automatically evaluated</p>
      <p>${result.manual} question(s) require manual review.</p>
    </div>

    ${result.rows.map(row => `
      <div class="result-row">
        <strong>${escapeHtml(row.question.subject)} — Q${escapeHtml(row.question.number)}</strong>
        <span>${escapeHtml(row.result)}</span>
        <p>Your answer: ${escapeHtml(row.given || "Not answered")}</p>
        <p>Reference: ${escapeHtml(row.expected || "Not available")}</p>
      </div>
    `).join("")}
  `;

  $("resultModal").hidden = false;
}

/* ---------------- HISTORY ---------------- */

function recordHistory(result) {
  const history = getHistory();

  history.unshift({
    date: new Date().toLocaleString(),
    student: $("studentName").value.trim(),
    email: $("studentEmail").value.trim(),
    earned: result.earned,
    possible: result.possible,
    percentage: result.percentage,
    manual: result.manual,
    count: state.questions.length
  });

  saveHistory(history.slice(0, 100));
}

function renderHistory() {
  const history = getHistory();

  $("historyList").innerHTML = history.length
    ? history.map(item => `
      <div class="history-card">
        <strong>${escapeHtml(item.date)}</strong>
        <p>${escapeHtml(item.student || "Student")} —
          ${escapeHtml(item.earned)} / ${escapeHtml(item.possible)}
          (${escapeHtml(item.percentage)}%)</p>
        <small>${escapeHtml(item.count)} questions ·
          ${escapeHtml(item.manual)} manual reviews</small>
      </div>
    `).join("")
    : "<p>No history available.</p>";
}

/* ---------------- GOOGLE SHEETS SUBMISSION ---------------- */

async function submitToBackend(result) {
  if (!BACKEND_URL || BACKEND_URL.includes("PASTE_YOUR")) {
    status("Evaluation complete. Add your Apps Script URL to enable Sheets saving.");
    return;
  }

  const payload = {
    action: "submitExam",
    studentName: $("studentName").value.trim(),
    email: $("studentEmail").value.trim(),
    questionPaper: state.questionFileName,
    answerKey: state.answerFileName,
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
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    status("Evaluation complete. Submission request sent to Google Sheets.");
  } catch (error) {
    console.error(error);
    status("Evaluation complete locally. Sheets submission failed.");
  }
}

/* ---------------- CSV EXPORT ---------------- */

function exportCsv() {
  if (!state.questions.length) {
    status("No questions to export.");
    return;
  }

  const rows = [[
    "Subject", "Question Number", "Question", "Type",
    "Student Answer", "Reference Answer", "Result",
    "Marks", "Maximum Marks"
  ]];

  for (const q of state.questions) {
    const evaluation = evaluateQuestion(q);

    rows.push([
      q.subject,
      q.number,
      q.text,
      q.type,
      evaluation.given,
      evaluation.expected,
      evaluation.result,
      evaluation.score ?? "",
      q.marks
    ]);
  }

  const csv = rows.map(row =>
    row.map(value =>
      `"${String(value ?? "").replace(/"/g, '""')}"`
    ).join(",")
  ).join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "Jus-Exam-Study-Answers.csv";
  link.click();

  URL.revokeObjectURL(url);
}

/* ---------------- PROCESS UPLOADS ---------------- */

async function processPdfs() {
  const que = $("questionPdf").files[0];
  const ans = $("answerPdf").files[0];
  const book = $("answerBookPdf").files[0];

  if ((!que && !book) || (que && book)) {
    status("Upload QUE + optional ANS, or upload ANSBOOK on its own.");
    return;
  }

  $("processBtn").disabled = true;
  $("processBtn").textContent = "Processing...";

  try {
    state.answers = {};
    state.questions = [];

    if (book) {
      status("Reading combined ANSBOOK PDF...");

      const text = await readPdf(book);

      state.questionText = text;
      state.questionFileName = book.name;
      state.answerBookFileName = book.name;

      showPdfPreview(book);

      state.questions = parseQuestions(text);
      attachCombinedAnswers(state.questions, text);

    } else {
      status("Reading QUE question paper...");

      const text = await readPdf(que);

      state.questionText = text;
      state.questionFileName = que.name;

      showPdfPreview(que);

      state.questions = parseQuestions(text);

      if (ans) {
        status("Reading ANS answer key...");

        const answerText = await readPdf(ans);
        const answerMap = parseAnswerKey(answerText);

        state.answerFileName = ans.name;
        attachAnswerKey(state.questions, answerMap);
      }
    }

    if (!state.questions.length) {
      status("No numbered questions detected. This PDF may be scanned or have unusual formatting.");
      return;
    }

    renderAll();
    $("evaluateBtn").disabled = false;
    saveDraft();

    const references = state.questions.filter(q => q.referenceAnswer).length;

    status(
      `${state.questions.length} questions extracted. ` +
      `${references} reference answers detected. Please review them.`
    );

  } catch (error) {
    console.error(error);
    status("Could not read the PDF. Check that it contains selectable text.");
  } finally {
    $("processBtn").disabled = false;
    $("processBtn").textContent = "Process PDFs";
  }
}

/* ---------------- FILE NAME LABELS ---------------- */

function connectFileInput(inputId, labelId) {
  $(inputId).addEventListener("change", () => {
    const file = $(inputId).files[0];
    $(labelId).textContent = file ? file.name : "No file selected";
  });
}

/* ---------------- EVENT LISTENERS ---------------- */

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
  if (!confirm("Clear all local practice history?")) return;
  saveHistory([]);
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

$("printBtn").addEventListener("click", () => window.print());

connectFileInput("questionPdf", "questionName");
connectFileInput("answerPdf", "answerName");
connectFileInput("answerBookPdf", "answerBookName");

/* ---------------- STARTUP ---------------- */

$("resultModal").hidden = true;
$("historySection").hidden = true;

restoreDraft();
renderHistory();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(error => console.warn("PWA registration failed", error));
  });
}
