/**
 * Transfer persistent knowledge into the knowledge base upon owner approval (FRD-F22 / US-KNOW-04).
 *
 * @param {Object} params
 * @param {Object} params.project
 * @param {Object} params.proposal
 * @param {Object} params.approver
 * @returns {Promise<Object>}
 */
export async function transferToKnowledgeBase({ project, proposal, approver } = {}) {
  project.declarations = project.declarations || [];
  project.proposals = project.proposals || [];

  // Check if target record was already decided (freeze / immutability)
  if (proposal?.record_id) {
    const existingDecl = project.declarations.find((d) => d.id === proposal.record_id);
    if (existingDecl && existingDecl.kt_state === 'approved') {
      return {
        status: 'blocked',
        code: 'ALREADY_DECIDED',
        kt_state: existingDecl.kt_state,
        declaration: null,
        record: null,
        message: `Bản ghi ${proposal.record_id} đã được duyệt trước đó, không thể sửa đổi tại chỗ`,
      };
    }
  }

  // Check replay (same proposal_id already approved)
  const existingDecl = project.declarations.find((d) => d.proposal_id === proposal.id);
  if (existingDecl) {
    return {
      status: 'replay',
      kt_state: existingDecl.kt_state || 'approved',
      declaration: existingDecl,
      record: existingDecl.record,
    };
  }

  // Check owner assignment for kind
  const expectedOwner = (project.kindOwners && project.kindOwners[proposal.kind]) || '';
  if (!expectedOwner || !expectedOwner.trim()) {
    if (!project.proposals.some((p) => p.id === proposal.id)) {
      project.proposals.push({
        ...proposal,
        status: 'pending',
      });
    }
    return {
      status: 'blocked',
      code: 'OWNER_UNASSIGNED',
      kt_state: null,
      declaration: null,
      record: null,
      message: `loại ${proposal.kind} chưa có chủ`,
    };
  }

  // Check self-approval / machine approval
  if (approver?.role === 'agent' || approver?.role !== 'owner') {
    if (!project.proposals.some((p) => p.id === proposal.id)) {
      project.proposals.push({
        ...proposal,
        status: 'pending',
      });
    }
    return {
      status: 'pending',
      code: 'SELF_APPROVAL',
      kt_state: null,
      declaration: null,
      record: null,
      message: 'Đề xuất đang chờ owner duyệt, máy không thể tự duyệt',
    };
  }

  // Check foreign approver (approver must be the owner of the proposal kind)
  if (approver?.id !== expectedOwner) {
    return {
      status: 'blocked',
      code: 'FOREIGN_APPROVER',
      kt_state: null,
      declaration: null,
      record: null,
      message: `người duyệt không phải chủ của loại ${proposal.kind}`,
    };
  }

  // Owner decision
  const record = {
    actor: approver.id,
    reason: approver.reason || '',
    at: new Date().toISOString(),
  };

  if (approver.decision === 'reject') {
    const propIndex = project.proposals.findIndex((p) => p.id === proposal.id);
    const proposalEntry = {
      ...proposal,
      status: 'rejected',
      record,
    };
    if (propIndex >= 0) {
      project.proposals[propIndex] = proposalEntry;
    } else {
      project.proposals.push(proposalEntry);
    }

    return {
      status: 'rejected',
      kt_state: 'rejected',
      declaration: null,
      record,
    };
  }

  // Approved
  const declaration = {
    id: `decl-${proposal.id}`,
    project: project.id,
    kind: proposal.kind,
    title: proposal.title,
    content: proposal.content,
    source: proposal.source,
    proposal_id: proposal.id,
    kt_state: 'approved',
    status: 'current',
    record,
  };
  project.declarations.push(declaration);

  const propIndex = project.proposals.findIndex((p) => p.id === proposal.id);
  const proposalEntry = {
    ...proposal,
    status: 'approved',
    record,
  };
  if (propIndex >= 0) {
    project.proposals[propIndex] = proposalEntry;
  } else {
    project.proposals.push(proposalEntry);
  }

  return {
    status: 'approved',
    kt_state: 'approved',
    declaration,
    record,
  };
}
