/** Preserve the material selection recorded on a trip, including legacy single-line dispatches. */
function dispatchMaterials(job, po) {
  if (Array.isArray(job.materials) && job.materials.length) return job.materials;
  if (job.additionalItems?.length) return [job, ...job.additionalItems];
  const lines = po?.materials?.length ? po.materials : po ? [po, ...(po.additionalItems || [])] : [];
  if (job.materialId || job.materialName) {
    const source = lines.find(line => job.materialId ? line.materialId === job.materialId : line.materialName === job.materialName) || {};
    return [{ ...source, materialId: job.materialId || source.materialId || '', materialName: job.materialName || source.materialName || '', quantity: job.quantityDispatched ?? job.quantityOrdered ?? job.quantity ?? source.quantity ?? 0, unit: job.unit || source.unit || '', ...(source.measurementType ? { measurementType: source.measurementType } : {}) }];
  }
  return lines;
}
module.exports = { dispatchMaterials };
