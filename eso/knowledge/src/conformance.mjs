/**
 * Run knowledge conformance checks against a project (FRD-F23 / US-KNOW-05 / INV-KB-04).
 *
 * @param {Object} params
 * @param {string} params.projectRoot
 * @param {Array<Object>} [params.catalog]
 * @returns {Promise<Object>}
 */
export async function runConformance({ projectRoot, catalog = [] } = {}) {
  const verdicts = [];

  for (const check of catalog) {
    const checkId = check.check_id || '';

    // If check implementation was deleted / missing run function
    if (!check.run || typeof check.run !== 'function') {
      verdicts.push({
        check_id: checkId,
        title: check.title,
        status: 'OUT',
        reason: 'phép kiểm đã mất: không tìm thấy cài đặt thực thi',
      });
      continue;
    }

    try {
      const outcome = await check.run({ projectRoot });
      const status = outcome.status;

      if (status === 'pass') {
        verdicts.push({
          check_id: checkId,
          title: check.title,
          status: 'pass',
          evidence: outcome.evidence || 'pass',
        });
      } else if (status === 'fail') {
        verdicts.push({
          check_id: checkId,
          title: check.title,
          status: 'fail',
          evidence: outcome.evidence || '',
          reason: outcome.reason || '',
        });
      } else {
        // 'OUT'
        verdicts.push({
          check_id: checkId,
          title: check.title,
          status: 'OUT',
          reason: outcome.reason || 'phép kiểm không áp dụng',
        });
      }
    } catch (error) {
      verdicts.push({
        check_id: checkId,
        title: check.title,
        status: 'OUT',
        reason: `thiếu dữ liệu: ${error.message}`,
      });
    }
  }

  const hasFail = verdicts.some((v) => v.status === 'fail');

  return {
    projectRoot,
    status: hasFail ? 'partial' : 'complete',
    verdicts,
  };
}
