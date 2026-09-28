let mockData = [];

const firebaseService = {
  async findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;
    let result = [...mockData];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(item => 
        JSON.stringify(item).toLowerCase().includes(s)
      );
    }
    if (status) {
      result = result.filter(item => item.status === status);
    }
    const start = (page - 1) * limit;
    return {
      data: result.slice(start, start + parseInt(limit)),
      total: result.length,
      page: parseInt(page),
      totalPages: Math.ceil(result.length / limit),
    };
  },

  async findById(id) {
    return mockData.find(item => item.id === id) || null;
  },

  async create(data) {
    const item = {
      id: \\\,
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockData.unshift(item);
    return item;
  },

  async update(id, data) {
    const index = mockData.findIndex(item => item.id === id);
    if (index === -1) return null;
    mockData[index] = { ...mockData[index], ...data, updatedAt: new Date().toISOString() };
    return mockData[index];
  },

  async delete(id) {
    const index = mockData.findIndex(item => item.id === id);
    if (index !== -1) mockData.splice(index, 1);
  },
};

module.exports = firebaseService;
