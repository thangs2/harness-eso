/**
 * Inventory knowledge sources and kinds for a project (FRD-F19 / US-KNOW-01).
 *
 * @param {Object} params
 * @param {Object} params.project
 * @param {Record<string, string>} [params.project.kindOwners]
 * @param {Array<Object>} [params.sources]
 * @returns {Promise<Object>}
 */
export async function inventoryKnowledge({ project, sources = [] } = {}) {
  const kindOwners = project?.kindOwners || {};

  if (!sources || sources.length === 0) {
    return {
      project,
      status: 'collected',
      total: 0,
      kinds: [],
      unseen: [],
      message: 'Dự án chưa có tri thức nào',
      suggestions: [
        'Khai báo loại tri thức đầu tiên',
        'Thiết lập locator tài liệu trong cấu hình dự án',
      ],
    };
  }

  let total = 0;
  const kinds = [];
  const unseen = [];

  for (const source of sources) {
    const kind = source.kind ?? '';
    const custodian = source.custodian ?? 'repo';
    const locator = source.locator ?? '';
    const owner = (kindOwners && kindOwners[kind]) ? String(kindOwners[kind]) : '';

    if (source.error) {
      const message = `Locator ${locator} không đọc được: ${source.error}`;
      kinds.push({
        kind,
        custodian,
        locator,
        owner,
        declared: false,
        count: null,
        missing: {
          code: 'LOCATOR_UNRESOLVED',
          message,
        },
      });
      unseen.push({
        code: 'UNSEEN_SCOPE',
        locator,
        message,
      });
    } else {
      const docCount = Array.isArray(source.documents) ? source.documents.length : 0;
      total += docCount;
      const isUnowned = !owner || owner.trim().length === 0;

      kinds.push({
        kind,
        custodian,
        locator,
        owner,
        declared: true,
        count: docCount,
        missing: isUnowned
          ? {
              code: 'KIND_UNOWNED',
              message: `loại ${kind} chưa có chủ`,
            }
          : null,
      });
    }
  }

  return {
    project,
    status: 'collected',
    total,
    kinds,
    unseen,
  };
}
