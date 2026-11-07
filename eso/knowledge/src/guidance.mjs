/**
 * Convert findings into actionable next steps (FRD-F21 / US-KNOW-03).
 *
 * @param {Object} params
 * @param {Object} params.project
 * @param {Record<string, string>} [params.project.kindOwners]
 * @param {Array<Object>} [params.findings]
 * @param {Record<string, string>} [params.playbooks]
 * @returns {Promise<Object>}
 */
export async function nextActions({
  project,
  findings = [],
  playbooks = {},
} = {}) {
  const rejected = [];
  const validSteps = [];
  const kindOwners = project?.kindOwners || {};

  for (const finding of findings) {
    const findingId = finding.id || '';
    const kind = finding.kind || '';
    const reason = finding.reason || '';

    // Check for vague action (e.g. "cần cải thiện")
    if (/cần cải thiện/i.test(reason) || !reason.trim()) {
      rejected.push({
        finding: findingId,
        code: 'VAGUE_ACTION',
        reason: `Phát hiện "${reason}" thiếu nội dung hành động cụ thể để tạo bước thực thi`,
      });
      continue;
    }

    // Check for unassigned owner (derived only from project.kindOwners)
    const owner = (kindOwners && kindOwners[kind]) || '';
    if (!owner || !owner.trim()) {
      rejected.push({
        finding: findingId,
        code: 'OWNER_UNASSIGNED',
        reason: `Loại tri thức "${kind}" chưa xác định người chịu trách nhiệm`,
      });
      continue;
    }

    const playbook = (playbooks && playbooks[kind]) || '';
    const consequence = finding.consequence || 'hậu quả vận hành';

    const step = {
      finding: findingId,
      kind,
      owner: owner.trim(),
      action: `Soạn thảo và ban hành tài liệu ${kind} [${findingId}]: ${reason}`,
      whyNow: `Giải quyết ngay để ngăn ngừa: ${consequence}`,
      blocker: `Chưa có bản thảo được phê duyệt cho loại ${kind}`,
      playbook,
    };

    if (finding.sourceExists === false || finding.source) {
      step.source = finding.source;
      if (finding.sourceExists === false) {
        step.note = `Tài liệu nguồn đã mất (${finding.source}), cần tạo lại`;
      }
    }

    validSteps.push(step);
  }

  const limit = 5;
  const next = validSteps.slice(0, limit);
  const result = {
    project,
    total: next.length,
    next,
    rejected,
  };

  if (validSteps.length > limit) {
    result.truncated = {
      code: 'TRUNCATED',
      omitted: validSteps.length - next.length,
    };
  }

  return result;
}
