function getPagination(query) {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 25), 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function getPagingMeta(count, page, limit) {
  return {
    page,
    limit,
    total: count,
    pages: Math.ceil(count / limit),
  };
}

function getSort(query, fallback = 'createdAt') {
  const sortBy = query.sortBy || fallback;
  const sortOrder = String(query.sortOrder || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return [[sortBy, sortOrder]];
}

module.exports = { getPagination, getPagingMeta, getSort };
