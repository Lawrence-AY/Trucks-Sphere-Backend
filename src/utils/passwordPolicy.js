const MIN_PASSWORD_LENGTH = 12;
const MIN_PASSWORD_SCORE = 4;
const PREDICTABLE_PASSWORD_PATTERNS = [
  'password',
  'qwerty',
  'letmein',
  'welcome',
  'admin',
  '123456',
  'abcdef',
];

function hasPredictableSequence(value) {
  return /(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|defg|qwer|wert|erty|rtyu|tyui|yuio|uiop)/.test(value.toLowerCase());
}

function assessPassword(password) {
  const value = typeof password === 'string' ? password : '';
  const checks = {
    length: value.length >= MIN_PASSWORD_LENGTH,
    lowercase: /[a-z]/.test(value),
    uppercase: /[A-Z]/.test(value),
    number: /\d/.test(value),
    special: /[^A-Za-z0-9\s]/.test(value),
    noWhitespace: !/\s/.test(value),
    noCommonPattern: !PREDICTABLE_PASSWORD_PATTERNS.some((pattern) => value.toLowerCase().includes(pattern)),
    noSequence: !hasPredictableSequence(value),
    noLongRepeat: !/(.)\1{3,}/.test(value),
  };
  const score = [checks.length, checks.lowercase && checks.uppercase, checks.number, checks.special, checks.noWhitespace]
    .filter(Boolean)
    .length;
  const errors = [];
  if (!checks.length) errors.push(`be at least ${MIN_PASSWORD_LENGTH} characters long`);
  if (!checks.lowercase) errors.push('include a lowercase letter');
  if (!checks.uppercase) errors.push('include an uppercase letter');
  if (!checks.number) errors.push('include a number');
  if (!checks.special) errors.push('include a special character');
  if (!checks.noWhitespace) errors.push('not contain whitespace');
  if (!checks.noCommonPattern) errors.push('not use common words or number patterns');
  if (!checks.noSequence) errors.push('not use predictable character sequences');
  if (!checks.noLongRepeat) errors.push('not repeat the same character four or more times in a row');

  return { valid: errors.length === 0 && score >= MIN_PASSWORD_SCORE, score, checks, errors };
}

function assertStrongPassword(password) {
  const assessment = assessPassword(password);
  if (!assessment.valid) {
    const error = new Error(`Password must ${assessment.errors.join(', ')}.`);
    error.statusCode = 400;
    error.code = 'WEAK_PASSWORD';
    error.passwordScore = assessment.score;
    throw error;
  }
  return assessment;
}

module.exports = { MIN_PASSWORD_LENGTH, MIN_PASSWORD_SCORE, assessPassword, assertStrongPassword };
