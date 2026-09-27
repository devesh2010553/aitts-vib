// Turns (test.questions, answers) into per-question results + totals.
// Bonus rule: a question flagged isBonus awards full marks to anyone who
// attempted it (picked an option, right or wrong) — correctness doesn't
// matter, no negative marking. Skipped bonus questions still count as
// not-attempted, same as any other skipped question.
//
// Used by:
//   - routes/results.js  POST /submit          (grading a fresh submission)
//   - dynamo/resultModel.js  regradeTest()      (re-grading past results
//     after an admin flags a question bonus post-hoc)
// Kept in one place on purpose: the bonus rule (or any future grading rule)
// only has to be right once, and the two call sites can never quietly
// diverge into different scoring behaviour.
function gradeAnswers(questions, answers) {
  let obtainedMarks = 0, correctAnswers = 0, wrongAnswers = 0, notAttempted = 0;
  const processedAnswers = [];

  for (const q of questions) {
    const ua = (answers || []).find(a => a.questionId === q.questionId);

    if (q.isMultiChoice) {
      const sel = (ua && ua.selectedOptions) || [];
      if (!sel.length) {
        notAttempted++;
        processedAnswers.push({ questionId: q.questionId, selectedOption: -1, selectedOptions: [], isCorrect: false, marksAwarded: 0 });
        continue;
      }
      if (q.isBonus) {
        correctAnswers++;
        obtainedMarks += q.marks;
        processedAnswers.push({ questionId: q.questionId, selectedOption: -1, selectedOptions: sel, isCorrect: true, marksAwarded: q.marks });
        continue;
      }
      const cor = q.options.reduce((a, o, i) => { if (o.isCorrect) a.push(i); return a; }, []);
      const ok = cor.every(i => sel.includes(i)) && sel.every(i => cor.includes(i));
      const ma = ok ? q.marks : -(q.negativeMarks || 0);
      if (ok) correctAnswers++; else wrongAnswers++;
      obtainedMarks += ma;
      processedAnswers.push({ questionId: q.questionId, selectedOption: -1, selectedOptions: sel, isCorrect: ok, marksAwarded: ma });
      continue;
    }

    const s = (ua != null && ua.selectedOption != null) ? ua.selectedOption : -1;
    if (s === -1) {
      notAttempted++;
      processedAnswers.push({ questionId: q.questionId, selectedOption: -1, isCorrect: false, marksAwarded: 0 });
      continue;
    }
    if (q.isBonus) {
      correctAnswers++;
      obtainedMarks += q.marks;
      processedAnswers.push({ questionId: q.questionId, selectedOption: s, isCorrect: true, marksAwarded: q.marks });
      continue;
    }
    const opt = q.options[s];
    if (opt && opt.isCorrect) {
      correctAnswers++; obtainedMarks += q.marks;
      processedAnswers.push({ questionId: q.questionId, selectedOption: s, isCorrect: true, marksAwarded: q.marks });
    } else {
      wrongAnswers++; const neg = q.negativeMarks || 0; obtainedMarks -= neg;
      processedAnswers.push({ questionId: q.questionId, selectedOption: s, isCorrect: false, marksAwarded: -neg });
    }
  }

  return { processedAnswers, obtainedMarks, correctAnswers, wrongAnswers, notAttempted };
}

module.exports = { gradeAnswers };
