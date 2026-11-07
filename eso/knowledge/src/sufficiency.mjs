/**
 * Sufficiency report for a project's knowledge base (FRD-F20 / US-KNOW-02).
 *
 * @param {Object} params
 * @param {Object} params.project
 * @param {Record<string, string>} [params.project.kindOwners]
 * @param {Object} [params.template]
 * @param {Array<Object>} [params.declarations]
 * @returns {Promise<Object>}
 */
export async function sufficiencyReport({
  project,
  template,
  declarations = [],
} = {}) {
  const kindOwners = project?.kindOwners || {};

  if (!template || !Array.isArray(template.kinds)) {
    return {
      status: 'blocked',
      code: 'NOT_MEASURED',
      findings: [],
      message: `Dự án ${project?.id || project || ''} chưa có template để đo. Không thể đánh giá độ đầy đủ.`,
    };
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  const findings = [];

  for (const tpl of template.kinds) {
    const kind = tpl.kind;
    const consequence = tpl.consequence || '';
    const owner = (kindOwners && kindOwners[kind]) ? String(kindOwners[kind]) : '';

    const decls = declarations.filter((d) => d.kind === kind);
    if (decls.length === 0) {
      findings.push({
        code: 'MISSING_KIND',
        kind,
        reason: `Dự án chưa có tài liệu nào thuộc loại ${kind}`,
        consequence,
        owner,
      });
      continue;
    }

    // Check for CONTENT_CONTRADICTS via derivedFrom
    let hasContradiction = false;
    for (const decl of decls) {
      if (decl.derivedFrom) {
        const sourceDoc = declarations.find((d) => d.path === decl.derivedFrom);
        if (sourceDoc && normalizeText(decl.content) !== normalizeText(sourceDoc.content)) {
          findings.push({
            code: 'CONTENT_CONTRADICTS',
            kind,
            reason: `Nội dung ${decl.id || decl.path} mâu thuẫn với nguồn ${decl.derivedFrom}`,
            consequence,
            owner,
          });
          hasContradiction = true;
          break;
        }
      }
    }
    if (hasContradiction) continue;

    // Check for NEAR_DUPLICATE (different id, same content)
    let hasDuplicate = false;
    const seenMap = new Map();
    for (const decl of decls) {
      const norm = normalizeText(decl.content);
      if (seenMap.has(norm)) {
        const first = seenMap.get(norm);
        if (first.id !== decl.id) {
          findings.push({
            code: 'NEAR_DUPLICATE',
            kind,
            reason: `Phát hiện các bản gần giống trùng lặp nội dung cho loại ${kind}`,
            consequence,
            copies: [first.path, decl.path],
            owner,
          });
          hasDuplicate = true;
          break;
        }
      } else {
        seenMap.set(norm, decl);
      }
    }
    if (hasDuplicate) continue;
  }

  // Construct summary message
  let message = '';
  if (findings.length === 0) {
    message = 'Tất cả các loại tri thức đều đầy đủ theo template.';
  } else {
    message = findings
      .map((f) => {
        if (f.code === 'MISSING_KIND') {
          return `Thiếu loại ${f.kind} dẫn đến ${f.consequence}`;
        }
        if (f.code === 'NEAR_DUPLICATE') {
          return `Loại ${f.kind} có bản ghi trùng lặp nội dung, hậu quả: ${f.consequence}`;
        }
        if (f.code === 'CONTENT_CONTRADICTS') {
          return `Loại ${f.kind} có nội dung mâu thuẫn nguồn, hậu quả: ${f.consequence}`;
        }
        return `${f.kind}: ${f.reason} (${f.consequence})`;
      })
      .join('; ');
  }

  return {
    status: 'measured',
    findings,
    message,
  };
}
