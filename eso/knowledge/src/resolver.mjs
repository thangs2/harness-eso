/**
 * Knowledge Resolver for ESO
 * Enforces project boundaries, shared promotion, and declaration zone validation.
 * Invariants:
 * - INV-KB-01: Mỗi kind đúng một người chịu — không chủ thì không duyệt được.
 * - INV-KB-02: Tri thức bền chỉ vào KB qua quyết định của người: máy không tự duyệt.
 * - INV-KB-03: Nâng shared => mọi project theo, trừ project đã đè, và việc đè phải hiện ra.
 * - BR-01: Cùng câu hỏi => cùng phán quyết.
 * - BR-10: pool/shared append-only; revert dời con trỏ, không xoá bản.
 * - BR-12: Cô lập project.
 */

const VALID_ZONES = new Set(['pool', 'shared', 'project']);

/**
 * Validates declaration against its declared zone.
 * @param {Object} declaration
 * @param {string} declaredZone
 * @returns {{ valid: boolean, code?: string, path?: string }}
 */
export function validateDeclarationZone(declaration, declaredZone) {
  if (!declaration || typeof declaration !== 'object') {
    return { valid: false, code: 'INVALID_DECLARATION' };
  }

  const zone = declaredZone || declaration.zone;
  if (!VALID_ZONES.has(zone)) {
    return {
      valid: false,
      code: 'OUT_OF_ZONE',
      path: declaration.path || declaration.file || String(declaration.id || 'unknown')
    };
  }

  if (declaration.path) {
    const normPath = declaration.path.replace(/\\/g, '/');
    if (zone === 'project' && (normPath.startsWith('pool/') || normPath.startsWith('shared/'))) {
      return { valid: false, code: 'OUT_OF_ZONE', path: declaration.path };
    }
    if (zone === 'shared' && (normPath.startsWith('pool/') || normPath.startsWith('project/'))) {
      return { valid: false, code: 'OUT_OF_ZONE', path: declaration.path };
    }
    if (zone === 'pool' && (normPath.startsWith('shared/') || normPath.startsWith('project/'))) {
      return { valid: false, code: 'OUT_OF_ZONE', path: declaration.path };
    }
    if (normPath.startsWith('../') || normPath.includes('/../')) {
      return { valid: false, code: 'OUT_OF_ZONE', path: declaration.path };
    }
  }

  if (declaration.zone && declaration.zone !== zone) {
    return { valid: false, code: 'OUT_OF_ZONE', path: declaration.path || String(declaration.id) };
  }

  return { valid: true };
}

/**
 * Checks if a declaration matches applies_when predicate given execution context.
 */
export function matchesAppliesWhen(declaration, context = {}) {
  if (!declaration || typeof declaration !== 'object') {
    return { matches: false, reason: 'invalid_declaration' };
  }

  const aw = declaration.applies_when;
  // Missing applies_when means unconditional match (DM-DECL / 03.declaration-format §1)
  if (!aw || (typeof aw === 'object' && Object.keys(aw).length === 0)) {
    return { matches: true };
  }

  // Parse stringified JSON if needed
  let parsedAw = aw;
  if (typeof aw === 'string') {
    try {
      parsedAw = JSON.parse(aw);
    } catch {
      return { matches: false, reason: 'malformed_applies_when' };
    }
  }

  if (parsedAw.always === true) {
    return { matches: true };
  }

  // Path / glob matching
  const patterns = parsedAw.paths || parsedAw.globs;
  if (Array.isArray(patterns) && patterns.length > 0) {
    const targetPaths = context.path ? [context.path] : (Array.isArray(context.paths) ? context.paths : []);
    if (targetPaths.length === 0) {
      return { matches: false, reason: 'paths_required', expected: patterns };
    }

    const matched = patterns.some((pat) => {
      const regexStr = '^' + pat
        .replace(/\./g, '\\.')
        .replace(/\*\*\//g, '.*')
        .replace(/\*/g, '[^/]*') + '$';
      const regex = new RegExp(regexStr);
      return targetPaths.some((tp) => regex.test(tp));
    });

    if (!matched) {
      return { matches: false, reason: 'paths_mismatch', expected: patterns, actual: targetPaths };
    }
  }

  // Tenant model matching
  if (parsedAw.tenant_model && context.tenant_model) {
    if (parsedAw.tenant_model !== context.tenant_model) {
      return {
        matches: false,
        reason: 'tenant_model_mismatch',
        expected: parsedAw.tenant_model,
        actual: context.tenant_model
      };
    }
  }

  // Consistency need matching
  if (parsedAw.consistency_need && context.consistency_need) {
    if (parsedAw.consistency_need !== context.consistency_need) {
      return {
        matches: false,
        reason: 'consistency_need_mismatch',
        expected: parsedAw.consistency_need,
        actual: context.consistency_need
      };
    }
  }

  return { matches: true };
}

/**
 * Resolves effective knowledge for a project from declarations.
 */
export function resolveEffectiveKnowledge(project, declarations = [], options = {}) {
  const result = {
    items: [],
    warnings: [],
    errors: []
  };

  if (!project) {
    result.errors.push({ code: 'MISSING_PROJECT', message: 'Project identifier is required' });
    return result;
  }

  if (!Array.isArray(declarations) || declarations.length === 0) {
    return result;
  }

  const validDeclarations = [];

  for (const decl of declarations) {
    const targetZone = decl.zone || (decl.project ? 'project' : 'shared');
    const zoneCheck = validateDeclarationZone(decl, targetZone);
    if (!zoneCheck.valid) {
      result.warnings.push({
        code: zoneCheck.code,
        path: zoneCheck.path,
        declarationId: decl.id
      });
      continue;
    }
    validDeclarations.push(decl);
  }

  const sharedMap = new Map();
  const projectMap = new Map();

  for (const decl of validDeclarations) {
    const key = decl.id || decl.key;
    const isShared = decl.zone === 'shared' || decl.zone === 'pool';

    if (isShared) {
      sharedMap.set(key, decl);
    } else if (decl.project === project) {
      projectMap.set(key, decl);
    }
  }

  const resolvedKeys = new Set([...sharedMap.keys(), ...projectMap.keys()]);

  for (const key of resolvedKeys) {
    const hasProjectOverride = projectMap.has(key);
    const hasShared = sharedMap.has(key);

    if (hasProjectOverride) {
      const projItem = projectMap.get(key);
      result.items.push({
        ...projItem,
        from: 'project',
        resolvedFrom: 'project',
        overridden: hasShared,
        sharedItemPresent: hasShared
      });
    } else if (hasShared) {
      const sharedItem = sharedMap.get(key);
      result.items.push({
        ...sharedItem,
        from: sharedItem.zone || 'shared',
        resolvedFrom: sharedItem.zone || 'shared',
        overridden: false
      });
    }
  }

  return result;
}

/**
 * Resolves declarations across three zones (project > shared > pool) according to BIP 5.1 & 5.2.
 *
 * @param {{ project: string, declarations: Array<Object>, context?: Object }} params
 * @returns {Array<Object>} Resolved[]
 */
export function resolveDeclarations({ project, declarations = [], context = {} } = {}) {
  if (!project || typeof project !== 'string') {
    throw new Error('Project identifier is required');
  }

  if (!Array.isArray(declarations) || declarations.length === 0) {
    return [];
  }

  // 1. Filter out revoked/superseded declarations and foreign project declarations
  const eligible = declarations.filter((d) => {
    if (!d || typeof d !== 'object') return false;
    // Status filter: only current declarations are eligible for election (D-33)
    if (d.status && d.status !== 'current') return false;
    // Project isolation: project zone items must match current project (BR-12)
    if (d.zone === 'project' && d.project && d.project !== project) return false;
    // Zone path validation: reject declarations outside their declared zone
    if (!validateDeclarationZone(d).valid) return false;
    // Check applies_when predicate against current execution context (AC-KB-02-01)
    if (!matchesAppliesWhen(d, context).matches) return false;
    return true;
  });

  // 2. Group by id
  const byId = new Map();
  for (const decl of eligible) {
    const id = decl.id || decl.key || decl.path;
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, []);
    }
    byId.get(id).push(decl);
  }

  const resolved = [];

  // Helper to format item pointer: `${zone}/${path}@${version}`
  const formatPointer = (d) => {
    const p = d.path || d.id;
    const v = d.version || '1.0';
    const z = d.zone || (d.project ? 'project' : 'shared');
    return `${z}/${p}@${v}`;
  };

  // 3. Resolve each id
  for (const [id, candidates] of byId.entries()) {
    const projectItem = candidates.find((c) => c.zone === 'project' || c.project === project);
    const sharedItem = candidates.find((c) => c.zone === 'shared');
    const poolItem = candidates.find((c) => c.zone === 'pool');

    let winner = null;
    let fromZone = null;
    const overriddenList = [];

    if (projectItem) {
      // Level 1: Project override
      winner = projectItem;
      fromZone = 'project';
      if (sharedItem) overriddenList.push(formatPointer(sharedItem));
      if (poolItem) overriddenList.push(formatPointer(poolItem));
    } else if (sharedItem) {
      // Level 3: Shared inheritance
      winner = sharedItem;
      fromZone = 'shared';
      if (poolItem) overriddenList.push(formatPointer(poolItem));
    } else if (poolItem && (poolItem.uses || poolItem.used_by_project || poolItem.direct_use)) {
      // Level 2: Project uses pool directly
      winner = poolItem;
      fromZone = 'pool';
    } else if (poolItem) {
      // Pool item not used -> pool is only library source, does not auto-apply (D-30)
      continue;
    }

    if (winner) {
      const item = {
        id,
        kind: winner.kind || 'skill',
        path: winner.path || id,
        version: winner.version || '1.0',
        from: fromZone,
        ...(overriddenList.length > 0 ? { overridden_by: overriddenList } : {}),
      };
      resolved.push(item);
    }
  }

  // 4. Sort strictly by id codepoint for deterministic byte-identical replay (DoD / 5.1 / AC-KB-02-06)
  resolved.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return resolved;
}

/**
 * Explains why a knowledge item was applied or why it was rejected.
 *
 * Implements:
 * - AC-KB-02-01: Selected item with from = project/shared/pool.
 * - AC-KB-02-02: Not selected item with reasons (applies_when_mismatch, superseded, overridden, out_of_zone).
 * - AC-KB-02-03: Override winner with overridden_by list.
 * - AC-KB-02-05: 0 declarations match returns empty resolved [] with explanation, 0 errors.
 * - AC-KB-02-07: When project override is removed/revoked, underlying shared declaration is returned.
 */
export function explainKnowledgeResolution({ project, declarations = [], targetId, context = {} } = {}) {
  const resolved = resolveDeclarations({ project, declarations, context });

  if (targetId) {
    const selected = resolved.find((r) => r.id === targetId);
    if (selected) {
      return {
        selected: true,
        item: selected,
        from: selected.from,
        overridden_by: selected.overridden_by || [],
        reason: 'matched',
        context,
      };
    }

    // Target was not selected: identify why across candidates
    const rawCandidates = declarations.filter((d) => (d.id === targetId || d.key === targetId));
    if (rawCandidates.length === 0) {
      return {
        selected: false,
        reason: 'not_found',
        reasons: ['not_found'],
        targetId,
        message: `Declaration '${targetId}' was not found in any zone`,
      };
    }

    const reasons = [];
    for (const c of rawCandidates) {
      if (c.status && c.status !== 'current') {
        reasons.push(`status_${c.status}`);
      } else if (!validateDeclarationZone(c).valid) {
        reasons.push('out_of_zone');
      } else if (c.zone === 'project' && c.project && c.project !== project) {
        reasons.push('foreign_project');
      } else {
        const matchRes = matchesAppliesWhen(c, context);
        if (!matchRes.matches) {
          reasons.push(`applies_when_mismatch:${matchRes.reason}`);
        } else {
          // Matched but not selected -> must have been overridden or pool without uses
          if (c.zone === 'pool' && !c.uses && !c.used_by_project) {
            reasons.push('pool_not_used');
          } else {
            reasons.push('overridden_by_higher_zone');
          }
        }
      }
    }

    return {
      selected: false,
      reason: reasons[0] || 'not_selected',
      reasons,
      targetId,
      candidates_count: rawCandidates.length,
    };
  }

  // No specific targetId: summary of entire resolution
  const unmatched = [];
  for (const d of declarations) {
    const id = d.id || d.key;
    if (!resolved.some((r) => r.id === id)) {
      const matchRes = matchesAppliesWhen(d, context);
      unmatched.push({
        id,
        zone: d.zone,
        reason: !matchRes.matches ? matchRes.reason : (d.status !== 'current' ? `status_${d.status}` : 'unselected'),
      });
    }
  }

  return {
    resolved,
    total_candidates: declarations.length,
    unmatched_count: unmatched.length,
    unmatched,
  };
}

/**
 * Query knowledge item with foreign-project opacity.
 */
export function queryKnowledgeItem(project, itemId, declarations = [], options = {}) {
  if (!project || !itemId) {
    return {
      found: false,
      error: 'NOT_FOUND',
      exists: 'absent',
      visibility: 'not-visible'
    };
  }

  const candidates = declarations.filter(d => (d.id === itemId || d.key === itemId));

  if (candidates.length === 0) {
    return {
      found: false,
      error: 'NOT_FOUND',
      exists: 'absent',
      visibility: 'not-visible'
    };
  }

  const visibleItem = candidates.find(d => {
    if (d.zone === 'shared' || d.zone === 'pool') return true;
    return d.project === project;
  });

  if (visibleItem) {
    return {
      found: true,
      exists: 'present',
      visibility: 'visible',
      item: {
        ...visibleItem,
        resolvedFrom: visibleItem.zone === 'shared' || visibleItem.zone === 'pool'
          ? (visibleItem.zone || 'shared')
          : 'project'
      }
    };
  }

  return {
    found: false,
    error: 'NOT_FOUND',
    exists: 'present',
    visibility: 'not-visible'
  };
}
