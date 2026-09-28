function receiptReference(job) {
  return String(job?.receiptNoteId || job?.receiptNote || job?.grnNumber || '').trim();
}
module.exports = { receiptReference };
