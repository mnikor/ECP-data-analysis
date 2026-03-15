import { jStat } from 'jstat';
import * as ss from 'simple-statistics';
import { AnalysisConcept, ClinicalFile, ResultTable, StatAnalysisResult, StatTestType } from '../types';
import { CsvRow, getNumericPairs, parseCsv, toNumber } from './dataProcessing';
import { formatChartTitle, formatComparisonLabel, formatDisplayName } from './displayNames';

const normalizeTestType = (raw: string): StatTestType | null => {
  const value = raw.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (value.includes('kaplan') || value.includes('log-rank') || value.includes('log rank')) {
    return StatTestType.KAPLAN_MEIER;
  }
  if (value.includes('cox') || value.includes('hazard')) return StatTestType.COX_PH;
  if (value.includes('chi')) return StatTestType.CHI_SQUARE;
  if (value.includes('anova')) return StatTestType.ANOVA;
  if (value.includes('t-test') || value.includes('t test') || value.includes('ttest')) return StatTestType.T_TEST;
  if (value.includes('regression')) return StatTestType.REGRESSION;
  if (value.includes('correlation') || value.includes('corr')) return StatTestType.CORRELATION;
  return null;
};

const formatPValue = (value: number): string => {
  if (!Number.isFinite(value)) return 'N/A';
  if (value < 0.0001) return '< 0.0001';
  return value.toFixed(4);
};

const getOutcomeVariable = (rows: CsvRow[], var1: string, var2?: string): string => {
  if (var2) return var2;
  const firstRow = rows[0] || {};
  const fallback = Object.keys(firstRow).find((key) => key !== var1);
  if (!fallback) throw new Error('No outcome variable available.');
  return fallback;
};

const buildGroupedNumeric = (rows: CsvRow[], groupVar: string, outcomeVar: string): Record<string, number[]> => {
  const grouped: Record<string, number[]> = {};
  rows.forEach((row) => {
    const group = (row[groupVar] ?? '').trim();
    const outcome = toNumber(row[outcomeVar]);
    if (!group || outcome == null) return;
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(outcome);
  });
  return grouped;
};

const correlationPValue = (r: number, n: number): number => {
  if (n < 3 || Math.abs(r) >= 1) return Number.NaN;
  const t = (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r);
  return 2 * (1 - jStat.studentt.cdf(Math.abs(t), n - 2));
};

const buildBoxChart = (
  grouped: Record<string, number[]>,
  title: string,
  groupLabel: string,
  outcomeLabel: string
) => {
  return {
    data: Object.entries(grouped).map(([group, values]) => ({
      type: 'box',
      name: group,
      y: values,
      boxpoints: 'outliers',
    })),
    layout: {
      title: formatChartTitle(title),
      xaxis: { title: groupLabel },
      yaxis: { title: outcomeLabel },
    },
  };
};

const wrapAxisLabel = (value: string, maxLength = 18): string => {
  const normalized = value.replace(/_/g, ' ');
  if (normalized.length <= maxLength) return normalized;

  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= maxLength) {
      currentLine = candidate;
      return;
    }

    if (currentLine) lines.push(currentLine);

    if (word.length <= maxLength) {
      currentLine = word;
      return;
    }

    const chunks = word.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [word];
    lines.push(...chunks.slice(0, -1));
    currentLine = chunks[chunks.length - 1];
  });

  if (currentLine) lines.push(currentLine);
  return lines.join('<br>');
};

const buildChiSquareHeatmap = (
  table: Record<string, Record<string, number>>,
  groups: string[],
  outcomes: string[],
  rowTotals: Record<string, number>,
  groupVar: string,
  outcomeVar: string,
  concept?: AnalysisConcept | null
) => {
  const z = groups.map((group) =>
    outcomes.map((outcome) => {
      const count = table[group]?.[outcome] || 0;
      return rowTotals[group] > 0 ? Number(((count / rowTotals[group]) * 100).toFixed(2)) : 0;
    })
  );

  const text = groups.map((group) =>
    outcomes.map((outcome) => {
      const count = table[group]?.[outcome] || 0;
      const percent = rowTotals[group] > 0 ? ((count / rowTotals[group]) * 100).toFixed(1) : '0.0';
      return `${count}<br>${percent}%`;
    })
  );

  const maxLabelLength = Math.max(...groups.map((group) => group.length), 8);
  const leftMargin = Math.min(200, Math.max(110, maxLabelLength * 7));
  const groupLabel = formatDisplayName(groupVar);
  const outcomeLabel = formatDisplayName(concept ? concept.label : outcomeVar);
  const titleText = concept
    ? `${outcomeLabel} incidence by ${groupLabel}`
    : `${outcomeLabel} distribution by ${groupLabel}`;

  return {
    data: [
      {
        type: 'heatmap',
        x: outcomes.map((outcome) => wrapAxisLabel(outcome, 20)),
        y: groups.map((group) => wrapAxisLabel(group, 18)),
        z,
        text,
        texttemplate: '%{text}',
        textfont: { size: 12, color: '#0f172a' },
        colorscale: [
          [0, '#eff6ff'],
          [0.35, '#bfdbfe'],
          [0.65, '#60a5fa'],
          [1, '#1d4ed8'],
        ],
        zmin: 0,
        zmax: 100,
        hovertemplate:
          `${groupVar}: %{y}<br>${concept ? concept.label : outcomeVar}: %{x}<br>` +
          'Within-group share: %{z:.1f}%<br>Cell: %{text}<extra></extra>',
        xgap: 6,
        ygap: 6,
        colorbar: {
          title: 'Row %',
          tickvals: [0, 25, 50, 75, 100],
        },
      },
    ],
    layout: {
      title: formatChartTitle(titleText),
      xaxis: {
        side: 'top',
        automargin: true,
      },
      yaxis: {
        title: groupLabel,
        automargin: true,
        autorange: 'reversed',
      },
      height: Math.max(360, groups.length * 80 + outcomes.length * 36),
      margin: { l: leftMargin, r: 72, t: 72, b: 84 },
    },
  };
};

const buildMetricTable = (title: string, metrics: Record<string, string | number>): ResultTable => ({
  title,
  columns: ['parameter', 'value'],
  rows: Object.entries(metrics).map(([parameter, value]) => ({
    parameter: parameter.replace(/_/g, ' '),
    value: String(value),
  })),
});

type SurvivalRecord = {
  group: string;
  time: number;
  event: boolean;
  covariate: number;
};

type KaplanMeierCurve = {
  x: number[];
  y: number[];
  censorX: number[];
  censorY: number[];
  n: number;
  events: number;
  censored: number;
  medianSurvival: number | null;
};

const KAPLAN_MEIER_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#dc2626', '#0f766e'];

const normalizeFieldKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

const findHeaderByHints = (headers: string[], hints: string[]): string | null => {
  const normalizedHeaders = headers.map((header) => ({
    raw: header,
    normalized: normalizeFieldKey(header),
  }));

  for (const hint of hints) {
    const normalizedHint = normalizeFieldKey(hint);
    const exact = normalizedHeaders.find((header) => header.normalized === normalizedHint);
    if (exact) return exact.raw;
    const partial = normalizedHeaders.find((header) => header.normalized.includes(normalizedHint));
    if (partial) return partial.raw;
  }

  return null;
};

const inferSurvivalCensorColumn = (headers: string[], groupVar: string, timeVar: string): string | null =>
  findHeaderByHints(
    headers.filter((header) => header !== groupVar && header !== timeVar),
    ['CNSR', 'CENSOR', 'CENSORING', 'EVENT', 'EVENTFL', 'STATUS', 'OS_EVENT', 'PFS_EVENT', 'DEATH', 'DEATHFL']
  );

const parseEventObserved = (rawValue: string, censorColumn: string): boolean | null => {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;

  const usesCensorCoding = /cnsr|censor/.test(censorColumn.toLowerCase());

  if (['0', '0.0', 'n', 'no', 'false'].includes(value)) return usesCensorCoding ? true : false;
  if (['1', '1.0', 'y', 'yes', 'true'].includes(value)) return usesCensorCoding ? false : true;
  if (['event', 'death', 'dead', 'progressed', 'progression', 'failure'].some((token) => value.includes(token))) {
    return true;
  }
  if (['censored', 'alive', 'ongoing', 'no event'].some((token) => value.includes(token))) {
    return false;
  }

  return null;
};

const inferSurvivalEndpointLabel = (rows: CsvRow[], headers: string[], timeVar: string): string => {
  const parameterLabelColumn = findHeaderByHints(headers, ['PARAM', 'PARAMCD']);
  if (parameterLabelColumn) {
    const values = Array.from(new Set(rows.map((row) => (row[parameterLabelColumn] || '').trim()).filter(Boolean)));
    if (values.length === 1) {
      return formatDisplayName(values[0]);
    }
  }
  return formatDisplayName(timeVar);
};

const inferSurvivalTimeAxisLabel = (rows: CsvRow[], headers: string[], timeVar: string, endpointLabel: string): string => {
  const unitColumn =
    findHeaderByHints(headers, ['AVALU', 'TIMEU', 'UNIT']) ||
    headers.find((header) => normalizeFieldKey(header) === `${normalizeFieldKey(timeVar)}u`) ||
    null;

  if (!unitColumn) return endpointLabel;

  const units = Array.from(new Set(rows.map((row) => (row[unitColumn] || '').trim()).filter(Boolean)));
  if (units.length === 1) {
    return `${endpointLabel} (${units[0]})`;
  }

  return endpointLabel;
};

const extractSurvivalRecords = (
  rows: CsvRow[],
  headers: string[],
  groupVar: string,
  timeVar: string
): { records: SurvivalRecord[]; censorColumn: string; endpointLabel: string } => {
  const censorColumn = inferSurvivalCensorColumn(headers, groupVar, timeVar);
  if (!censorColumn) {
    throw new Error('A survival analysis requires a censoring/event column such as CNSR, STATUS, or EVENT.');
  }

  const records: SurvivalRecord[] = rows
    .map((row) => {
      const group = (row[groupVar] || '').trim();
      const time = toNumber(row[timeVar]);
      const eventObserved = parseEventObserved(row[censorColumn], censorColumn);
      if (!group || time == null || time < 0 || eventObserved == null) return null;
      return { group, time, event: eventObserved, covariate: Number.NaN };
    })
    .filter((record): record is SurvivalRecord => Boolean(record));

  if (records.length < 3) {
    throw new Error('A survival analysis requires at least three valid rows with group, time, and censoring values.');
  }

  return {
    records,
    censorColumn,
    endpointLabel: inferSurvivalEndpointLabel(rows, headers, timeVar),
  };
};

const buildKaplanMeierCurve = (records: SurvivalRecord[]): KaplanMeierCurve => {
  const sortedRecords = [...records].sort((left, right) => left.time - right.time);
  const uniqueTimes = Array.from(new Set(sortedRecords.map((record) => record.time))).sort((a, b) => a - b);
  let survival = 1;
  const x = [0];
  const y = [1];
  const censorX: number[] = [];
  const censorY: number[] = [];
  let medianSurvival: number | null = null;

  uniqueTimes.forEach((time) => {
    const atRisk = sortedRecords.filter((record) => record.time >= time).length;
    const events = sortedRecords.filter((record) => record.time === time && record.event).length;
    const censored = sortedRecords.filter((record) => record.time === time && !record.event).length;

    if (events > 0 && atRisk > 0) {
      x.push(time);
      y.push(survival);
      survival *= 1 - events / atRisk;
      x.push(time);
      y.push(survival);
      if (medianSurvival == null && survival <= 0.5) {
        medianSurvival = time;
      }
    }

    if (censored > 0) {
      censorX.push(...Array.from({ length: censored }, () => time));
      censorY.push(...Array.from({ length: censored }, () => survival));
    }
  });

  const events = sortedRecords.filter((record) => record.event).length;
  const censored = sortedRecords.length - events;

  return {
    x,
    y,
    censorX,
    censorY,
    n: sortedRecords.length,
    events,
    censored,
    medianSurvival,
  };
};

const invertMatrix = (matrix: number[][]): number[][] | null => {
  const size = matrix.length;
  if (size === 0) return [];

  const augmented = matrix.map((row, rowIndex) => [
    ...row.map((value) => (Number.isFinite(value) ? value : 0)),
    ...Array.from({ length: size }, (_, colIndex) => (rowIndex === colIndex ? 1 : 0)),
  ]);

  for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
    let pivotRow = pivotIndex;
    while (pivotRow < size && Math.abs(augmented[pivotRow][pivotIndex]) < 1e-12) {
      pivotRow += 1;
    }
    if (pivotRow === size) return null;

    if (pivotRow !== pivotIndex) {
      [augmented[pivotIndex], augmented[pivotRow]] = [augmented[pivotRow], augmented[pivotIndex]];
    }

    const pivot = augmented[pivotIndex][pivotIndex];
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) return null;

    for (let col = 0; col < size * 2; col += 1) {
      augmented[pivotIndex][col] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivotIndex) continue;
      const factor = augmented[row][pivotIndex];
      for (let col = 0; col < size * 2; col += 1) {
        augmented[row][col] -= factor * augmented[pivotIndex][col];
      }
    }
  }

  return augmented.map((row) => row.slice(size));
};

const multiplyMatrixVector = (matrix: number[][], vector: number[]) =>
  matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));

const computeLogRank = (records: SurvivalRecord[]) => {
  const groups = Array.from(new Set(records.map((record) => record.group)));
  if (groups.length < 2) {
    throw new Error('Kaplan-Meier / Log-Rank requires at least two groups.');
  }

  const uniqueEventTimes = Array.from(
    new Set(records.filter((record) => record.event).map((record) => record.time))
  ).sort((a, b) => a - b);

  const observed = new Array(groups.length).fill(0);
  const expected = new Array(groups.length).fill(0);
  const covariance = Array.from({ length: groups.length - 1 }, () =>
    new Array(groups.length - 1).fill(0)
  );

  uniqueEventTimes.forEach((time) => {
    const atRisk = groups.map(
      (group) => records.filter((record) => record.group === group && record.time >= time).length
    );
    const events = groups.map(
      (group) => records.filter((record) => record.group === group && record.time === time && record.event).length
    );

    const totalAtRisk = atRisk.reduce((sum, value) => sum + value, 0);
    const totalEvents = events.reduce((sum, value) => sum + value, 0);
    if (totalAtRisk <= 0 || totalEvents <= 0) return;

    groups.forEach((_, index) => {
      observed[index] += events[index];
      expected[index] += (atRisk[index] * totalEvents) / totalAtRisk;
    });

    if (totalAtRisk <= 1) return;
    const factor = (totalEvents * (totalAtRisk - totalEvents)) / (totalAtRisk * totalAtRisk * (totalAtRisk - 1));

    for (let row = 0; row < groups.length - 1; row += 1) {
      covariance[row][row] += factor * atRisk[row] * (totalAtRisk - atRisk[row]);
      for (let col = row + 1; col < groups.length - 1; col += 1) {
        const cov = -factor * atRisk[row] * atRisk[col];
        covariance[row][col] += cov;
        covariance[col][row] += cov;
      }
    }
  });

  const oe = observed.slice(0, -1).map((value, index) => value - expected[index]);
  const inverse = invertMatrix(covariance);
  if (!inverse) {
    throw new Error('Unable to compute a stable log-rank variance matrix for these groups.');
  }

  const weighted = multiplyMatrixVector(inverse, oe);
  const statistic = oe.reduce((sum, value, index) => sum + value * weighted[index], 0);
  const degreesOfFreedom = groups.length - 1;
  const pValue = 1 - jStat.chisquare.cdf(statistic, degreesOfFreedom);

  return { groups, statistic, degreesOfFreedom, pValue };
};

const runKaplanMeier = (rows: CsvRow[], headers: string[], groupVar: string, timeVar: string): StatAnalysisResult => {
  const { records, endpointLabel, censorColumn } = extractSurvivalRecords(rows, headers, groupVar, timeVar);
  const groupNames = Array.from(new Set(records.map((record) => record.group)));

  if (groupNames.length > 6) {
    throw new Error('Kaplan-Meier requires a categorical grouping variable with a manageable number of groups.');
  }

  const curves = groupNames.map((group) => ({
    group,
    curve: buildKaplanMeierCurve(records.filter((record) => record.group === group)),
  }));
  const logRank = computeLogRank(records);
  const groupLabel = formatDisplayName(groupVar);
  const timeLabel = inferSurvivalTimeAxisLabel(rows, headers, timeVar, endpointLabel);

  const chartConfig = {
    data: curves.flatMap(({ group, curve }, index) => {
      const color = KAPLAN_MEIER_COLORS[index % KAPLAN_MEIER_COLORS.length];
      const traces: Record<string, any>[] = [
        {
          type: 'scatter',
          mode: 'lines',
          name: group,
          x: curve.x,
          y: curve.y,
          line: { shape: 'hv', width: 3, color },
          legendgroup: group,
          hovertemplate: `${group}<br>Time: %{x}<br>Survival: %{y:.1%}<extra></extra>`,
        },
      ];

      if (curve.censorX.length > 0) {
        traces.push({
          type: 'scatter',
          mode: 'markers',
          name: `${group} censored`,
          x: curve.censorX,
          y: curve.censorY,
          marker: { symbol: 'line-ns-open', size: 8, color, opacity: 0.8, line: { color, width: 1 } },
          legendgroup: group,
          showlegend: false,
          hovertemplate: `${group}<br>Censored at %{x}<br>Survival: %{y:.1%}<extra></extra>`,
        });
      }

      return traces;
    }),
    layout: {
      title: formatChartTitle(`Kaplan-Meier: ${endpointLabel} by ${groupLabel}`),
      xaxis: { title: timeLabel },
      yaxis: { title: 'Survival Probability', tickformat: '.0%', range: [0, 1] },
      hovermode: 'x unified',
    },
  };

  const tableConfig: ResultTable = {
    title: `Kaplan-Meier summary for ${endpointLabel}`,
    columns: ['group', 'n', 'events', 'censored', 'median_survival'],
    rows: curves.map(({ group, curve }) => ({
      group,
      n: curve.n,
      events: curve.events,
      censored: curve.censored,
      median_survival: curve.medianSurvival == null ? 'Not reached' : curve.medianSurvival.toFixed(2),
    })),
  };

  return {
    metrics: {
      test: 'Kaplan-Meier / Log-Rank',
      groups: groupNames.length,
      total_n: records.length,
      total_events: records.filter((record) => record.event).length,
      total_censored: records.filter((record) => !record.event).length,
      censor_column: censorColumn,
      log_rank_statistic: logRank.statistic.toFixed(4),
      degrees_of_freedom: logRank.degreesOfFreedom,
      p_value: formatPValue(logRank.pValue),
    },
    interpretation:
      logRank.pValue < 0.05
        ? `Kaplan-Meier analysis detected a statistically significant difference in ${endpointLabel.toLowerCase()} across ${groupLabel} groups (log-rank p=${formatPValue(logRank.pValue)}).`
        : `Kaplan-Meier analysis did not detect a statistically significant difference in ${endpointLabel.toLowerCase()} across ${groupLabel} groups (log-rank p=${formatPValue(logRank.pValue)}).`,
    chartConfig,
    tableConfig,
    executedCode: `# Deterministic local execution\n# Kaplan-Meier / Log-Rank ${timeVar} by ${groupVar}`,
  };
};

const encodeCoxCovariate = (
  records: SurvivalRecord[],
  rows: CsvRow[],
  groupVar: string
): { encoded: SurvivalRecord[]; label: string; reference?: string; comparison?: string } => {
  const values = rows.map((row) => (row[groupVar] || '').trim()).filter(Boolean);
  const numericValues = values.map((value) => toNumber(value));
  const numericCoverage = numericValues.filter((value) => value != null).length;

  if (numericCoverage === values.length) {
    const covariateMap = new Map<string, number>();
    values.forEach((value) => covariateMap.set(value, Number(value)));
    return {
      encoded: records.map((record) => ({
        ...record,
        covariate: covariateMap.get(record.group) as number,
      })),
      label: `${formatDisplayName(groupVar)} (per unit increase)`,
    };
  }

  const distinctGroups = Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
  if (distinctGroups.length !== 2) {
    throw new Error('Cox proportional hazards is currently limited to a numeric covariate or a binary grouping variable.');
  }

  const [reference, comparison] = distinctGroups;
  return {
    encoded: records.map((record) => ({
      ...record,
      covariate: record.group === comparison ? 1 : 0,
    })),
    label: `${formatDisplayName(groupVar)} (${comparison} vs ${reference})`,
    reference,
    comparison,
  };
};

const runCox = (rows: CsvRow[], headers: string[], groupVar: string, timeVar: string): StatAnalysisResult => {
  const { records, endpointLabel, censorColumn } = extractSurvivalRecords(rows, headers, groupVar, timeVar);
  const events = records.filter((record) => record.event);
  if (events.length < 3) {
    throw new Error('Cox proportional hazards requires at least three observed events.');
  }

  const encoded = encodeCoxCovariate(records, rows, groupVar);
  const eventTimes = Array.from(new Set(encoded.encoded.filter((record) => record.event).map((record) => record.time))).sort((a, b) => a - b);

  let beta = 0;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    let score = 0;
    let information = 0;

    eventTimes.forEach((time) => {
      const riskSet = encoded.encoded.filter((record) => record.time >= time);
      const eventSet = encoded.encoded.filter((record) => record.time === time && record.event);
      const d = eventSet.length;
      if (d === 0) return;

      const weights = riskSet.map((record) => Math.exp(beta * record.covariate));
      const sumWeights = weights.reduce((sum, value) => sum + value, 0);
      const sumWeightedX = riskSet.reduce((sum, record) => sum + record.covariate * Math.exp(beta * record.covariate), 0);
      const sumWeightedX2 = riskSet.reduce(
        (sum, record) => sum + record.covariate * record.covariate * Math.exp(beta * record.covariate),
        0
      );
      const eventX = eventSet.reduce((sum, record) => sum + record.covariate, 0);

      score += eventX - d * (sumWeightedX / sumWeights);
      information += d * (sumWeightedX2 / sumWeights - (sumWeightedX / sumWeights) ** 2);
    });

    if (!Number.isFinite(information) || information <= 1e-12) {
      throw new Error('Unable to estimate a stable Cox proportional hazards model for the selected variable.');
    }

    const step = score / information;
    beta += step;
    if (Math.abs(step) < 1e-8) break;
  }

  let finalInformation = 0;
  eventTimes.forEach((time) => {
    const riskSet = encoded.encoded.filter((record) => record.time >= time);
    const eventSet = encoded.encoded.filter((record) => record.time === time && record.event);
    const d = eventSet.length;
    if (d === 0) return;
    const sumWeights = riskSet.reduce((sum, record) => sum + Math.exp(beta * record.covariate), 0);
    const sumWeightedX = riskSet.reduce((sum, record) => sum + record.covariate * Math.exp(beta * record.covariate), 0);
    const sumWeightedX2 = riskSet.reduce(
      (sum, record) => sum + record.covariate * record.covariate * Math.exp(beta * record.covariate),
      0
    );
    finalInformation += d * (sumWeightedX2 / sumWeights - (sumWeightedX / sumWeights) ** 2);
  });

  if (!Number.isFinite(finalInformation) || finalInformation <= 1e-12) {
    throw new Error('Unable to estimate uncertainty for the Cox proportional hazards model.');
  }

  const standardError = Math.sqrt(1 / finalInformation);
  const zStatistic = beta / standardError;
  const pValue = 2 * (1 - jStat.normal.cdf(Math.abs(zStatistic), 0, 1));
  const hazardRatio = Math.exp(beta);
  const ciLower = Math.exp(beta - 1.96 * standardError);
  const ciUpper = Math.exp(beta + 1.96 * standardError);
  const covariateLabel = encoded.label;

  return {
    metrics: {
      test: 'Cox Proportional Hazards',
      n: encoded.encoded.length,
      events: events.length,
      censor_column: censorColumn,
      coefficient_beta: beta.toFixed(4),
      standard_error: standardError.toFixed(4),
      hazard_ratio: hazardRatio.toFixed(4),
      ci_lower_95: ciLower.toFixed(4),
      ci_upper_95: ciUpper.toFixed(4),
      z_statistic: zStatistic.toFixed(4),
      p_value: formatPValue(pValue),
      ...(encoded.reference && encoded.comparison
        ? {
            reference_group: encoded.reference,
            comparison_group: encoded.comparison,
          }
        : {}),
    },
    interpretation:
      pValue < 0.05
        ? `Cox proportional hazards modeling detected a statistically significant hazard difference for ${endpointLabel.toLowerCase()} using ${covariateLabel} (HR=${hazardRatio.toFixed(2)}, p=${formatPValue(pValue)}).`
        : `Cox proportional hazards modeling did not detect a statistically significant hazard difference for ${endpointLabel.toLowerCase()} using ${covariateLabel} (HR=${hazardRatio.toFixed(2)}, p=${formatPValue(pValue)}).`,
    chartConfig: {
      data: [
        {
          type: 'scatter',
          mode: 'markers',
          x: [hazardRatio],
          y: [covariateLabel],
          marker: { size: 14, color: hazardRatio >= 1 ? '#dc2626' : '#2563eb' },
          error_x: {
            type: 'data',
            visible: true,
            array: [ciUpper - hazardRatio],
            arrayminus: [hazardRatio - ciLower],
          },
          hovertemplate: `${covariateLabel}<br>HR=%{x:.2f}<br>95% CI ${ciLower.toFixed(2)}-${ciUpper.toFixed(2)}<extra></extra>`,
        },
      ],
      layout: {
        title: formatChartTitle(`Cox model: ${endpointLabel}`),
        xaxis: { title: 'Hazard ratio', zeroline: false },
        yaxis: { automargin: true },
        shapes: [
          {
            type: 'line',
            x0: 1,
            x1: 1,
            y0: -0.5,
            y1: 0.5,
            line: { color: '#94a3b8', dash: 'dash' },
          },
        ],
      },
    },
    tableConfig: {
      title: `Cox proportional hazards summary for ${endpointLabel}`,
      columns: ['covariate', 'hazard_ratio', 'ci_95', 'p_value'],
      rows: [
        {
          covariate: covariateLabel,
          hazard_ratio: hazardRatio.toFixed(4),
          ci_95: `${ciLower.toFixed(4)} to ${ciUpper.toFixed(4)}`,
          p_value: formatPValue(pValue),
        },
      ],
    },
    executedCode: `# Deterministic local execution\n# Cox proportional hazards ${timeVar} ~ ${groupVar}`,
  };
};

const runTTest = (rows: CsvRow[], groupVar: string, outcomeVar: string): StatAnalysisResult => {
  const grouped = buildGroupedNumeric(rows, groupVar, outcomeVar);
  const groups = Object.entries(grouped).filter(([, values]) => values.length >= 2);

  if (groups.length !== 2) {
    throw new Error('T-Test requires exactly two groups with at least two numeric values each.');
  }

  const [groupA, groupB] = groups;
  const [nameA, valuesA] = groupA;
  const [nameB, valuesB] = groupB;
  const tStatistic = ss.tTestTwoSample(valuesA, valuesB, 0);
  const dof = valuesA.length + valuesB.length - 2;
  const pValue = 2 * (1 - jStat.studentt.cdf(Math.abs(tStatistic), dof));
  const groupLabel = formatDisplayName(groupVar);
  const outcomeLabel = formatDisplayName(outcomeVar);

  const chart = buildBoxChart(grouped, `T-Test: ${outcomeLabel} by ${groupLabel}`, groupLabel, outcomeLabel);
  const meanA = ss.mean(valuesA);
  const meanB = ss.mean(valuesB);
  const stdA = ss.sampleStandardDeviation(valuesA);
  const stdB = ss.sampleStandardDeviation(valuesB);
  const summaryTable: ResultTable = {
    title: `Group summary for ${outcomeLabel}`,
    columns: ['group', 'n', 'mean', 'standard_deviation'],
    rows: [
      {
        group: nameA,
        n: valuesA.length,
        mean: meanA.toFixed(4),
        standard_deviation: stdA.toFixed(4),
      },
      {
        group: nameB,
        n: valuesB.length,
        mean: meanB.toFixed(4),
        standard_deviation: stdB.toFixed(4),
      },
    ],
  };

  return {
    metrics: {
      test: 'T-Test',
      group_a: nameA,
      group_b: nameB,
      n_group_a: valuesA.length,
      n_group_b: valuesB.length,
      mean_group_a: meanA.toFixed(4),
      mean_group_b: meanB.toFixed(4),
      t_statistic: tStatistic.toFixed(4),
      degrees_of_freedom: dof,
      p_value: formatPValue(pValue),
    },
    interpretation:
      pValue < 0.05
        ? `Statistically significant difference detected between ${nameA} and ${nameB} for ${outcomeLabel} (p=${formatPValue(pValue)}).`
        : `No statistically significant difference detected between ${nameA} and ${nameB} for ${outcomeLabel} (p=${formatPValue(pValue)}).`,
    chartConfig: chart,
    tableConfig: summaryTable,
    executedCode: `# Deterministic local execution\n# T-Test on ${outcomeVar} grouped by ${groupVar}`,
  };
};

const runAnova = (rows: CsvRow[], groupVar: string, outcomeVar: string): StatAnalysisResult => {
  const grouped = buildGroupedNumeric(rows, groupVar, outcomeVar);
  const groups = Object.entries(grouped).filter(([, values]) => values.length >= 2);

  if (groups.length < 2) {
    throw new Error('ANOVA requires at least two groups with numeric outcomes.');
  }

  const samples = groups.map(([, values]) => values);
  const fStatistic = jStat.anovafscore(...samples);
  const totalN = samples.reduce((sum, sample) => sum + sample.length, 0);
  const df1 = samples.length - 1;
  const df2 = totalN - samples.length;
  const pValue = 1 - jStat.centralF.cdf(fStatistic, df1, df2);
  const groupLabel = formatDisplayName(groupVar);
  const outcomeLabel = formatDisplayName(outcomeVar);
  const chart = buildBoxChart(grouped, `ANOVA: ${outcomeLabel} by ${groupLabel}`, groupLabel, outcomeLabel);
  const summaryTable: ResultTable = {
    title: `Group summary for ${outcomeLabel}`,
    columns: ['group', 'n', 'mean', 'standard_deviation'],
    rows: groups.map(([name, values]) => ({
      group: name,
      n: values.length,
      mean: ss.mean(values).toFixed(4),
      standard_deviation: ss.sampleStandardDeviation(values).toFixed(4),
    })),
  };

  return {
    metrics: {
      test: 'ANOVA',
      groups: samples.length,
      total_n: totalN,
      f_statistic: fStatistic.toFixed(4),
      df_between: df1,
      df_within: df2,
      p_value: formatPValue(pValue),
    },
    interpretation:
      pValue < 0.05
        ? `At least one group mean differs significantly for ${outcomeLabel} across ${groupLabel} categories (p=${formatPValue(pValue)}).`
        : `No significant between-group mean differences detected for ${outcomeLabel} (p=${formatPValue(pValue)}).`,
    chartConfig: chart,
    tableConfig: summaryTable,
    executedCode: `# Deterministic local execution\n# ANOVA on ${outcomeVar} grouped by ${groupVar}`,
  };
};

const runRegression = (rows: CsvRow[], xVar: string, yVar: string): StatAnalysisResult => {
  const points = getNumericPairs(rows, xVar, yVar);
  if (points.length < 3) {
    throw new Error('Linear regression requires at least three numeric pairs.');
  }

  const model = ss.linearRegression(points.map((p) => [p.x, p.y]));
  const line = ss.linearRegressionLine(model);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const r = ss.sampleCorrelation(xs, ys);
  const rSquared = r * r;
  const pValue = correlationPValue(r, points.length);
  const xLabel = formatDisplayName(xVar);
  const yLabel = formatDisplayName(yVar);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const metrics = {
    test: 'Linear Regression',
    n: points.length,
    slope: model.m.toFixed(6),
    intercept: model.b.toFixed(6),
    correlation_r: r.toFixed(4),
    r_squared: rSquared.toFixed(4),
    p_value_slope: formatPValue(pValue),
  };

  return {
    metrics,
    interpretation:
      Number.isFinite(pValue) && pValue < 0.05
        ? `Significant linear association detected between ${xLabel} and ${yLabel} (R²=${rSquared.toFixed(3)}, p=${formatPValue(pValue)}).`
        : `No significant linear association detected between ${xLabel} and ${yLabel} (R²=${rSquared.toFixed(3)}, p=${formatPValue(pValue)}).`,
    chartConfig: {
      data: [
        {
          type: 'scatter',
          mode: 'markers',
          x: xs,
          y: ys,
          name: 'Observed',
        },
        {
          type: 'scatter',
          mode: 'lines',
          x: [minX, maxX],
          y: [line(minX), line(maxX)],
          name: 'Regression line',
        },
      ],
      layout: {
        title: formatChartTitle(`Linear Regression: ${yLabel} vs ${xLabel}`),
        xaxis: { title: xLabel },
        yaxis: { title: yLabel },
      },
    },
    tableConfig: {
      title: `Observed ${yLabel} by ${xLabel}`,
      columns: [xLabel, yLabel, 'predicted'],
      rows: points.slice(0, 25).map((point) => ({
        [xLabel]: point.x,
        [yLabel]: point.y,
        predicted: line(point.x).toFixed(4),
      })),
    },
    executedCode: `# Deterministic local execution\n# Linear regression ${yVar} ~ ${xVar}`,
  };
};

const runCorrelation = (rows: CsvRow[], xVar: string, yVar: string): StatAnalysisResult => {
  const points = getNumericPairs(rows, xVar, yVar);
  if (points.length < 3) {
    throw new Error('Correlation analysis requires at least three numeric pairs.');
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const r = ss.sampleCorrelation(xs, ys);
  const pValue = correlationPValue(r, points.length);
  const xLabel = formatDisplayName(xVar);
  const yLabel = formatDisplayName(yVar);
  const metrics = {
    test: 'Correlation',
    n: points.length,
    pearson_r: r.toFixed(4),
    p_value: formatPValue(pValue),
  };

  return {
    metrics,
    interpretation:
      Number.isFinite(pValue) && pValue < 0.05
        ? `Significant correlation detected between ${xLabel} and ${yLabel} (r=${r.toFixed(3)}, p=${formatPValue(pValue)}).`
        : `No significant correlation detected between ${xLabel} and ${yLabel} (r=${r.toFixed(3)}, p=${formatPValue(pValue)}).`,
    chartConfig: {
      data: [
        {
          type: 'scatter',
          mode: 'markers',
          x: xs,
          y: ys,
          name: 'Observed pairs',
        },
      ],
      layout: {
        title: formatChartTitle(`Correlation: ${yLabel} vs ${xLabel}`),
        xaxis: { title: xLabel },
        yaxis: { title: yLabel },
      },
    },
    tableConfig: {
      title: `Observed pairs for ${xLabel} and ${yLabel}`,
      columns: [xLabel, yLabel],
      rows: points.slice(0, 25).map((point) => ({
        [xLabel]: point.x,
        [yLabel]: point.y,
      })),
    },
    executedCode: `# Deterministic local execution\n# Correlation ${xVar} vs ${yVar}`,
  };
};

const runChiSquare = (
  rows: CsvRow[],
  groupVar: string,
  outcomeVar: string,
  concept?: AnalysisConcept | null
): StatAnalysisResult => {
  const outcomeResolver = (row: CsvRow): string => {
    if (!concept) return (row[outcomeVar] || '').trim();
    const value = (row[concept.sourceColumn] || '').toLowerCase();
    const isEvent = concept.terms.some((term) => value.includes(term.toLowerCase()));
    return isEvent ? `${concept.label}: present` : `${concept.label}: absent`;
  };

  const table: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  let total = 0;

  rows.forEach((row) => {
    const group = (row[groupVar] || '').trim();
    const outcome = outcomeResolver(row);
    if (!group || !outcome) return;

    if (!table[group]) table[group] = {};
    table[group][outcome] = (table[group][outcome] || 0) + 1;
    rowTotals[group] = (rowTotals[group] || 0) + 1;
    colTotals[outcome] = (colTotals[outcome] || 0) + 1;
    total += 1;
  });

  const groups = Object.keys(table);
  const outcomes = Object.keys(colTotals);
  if (groups.length < 2 || outcomes.length < 2 || total === 0) {
    throw new Error('Chi-square requires at least two groups and two outcome categories.');
  }

  let chi2 = 0;
  groups.forEach((g) => {
    outcomes.forEach((o) => {
      const observed = table[g][o] || 0;
      const expected = (rowTotals[g] * colTotals[o]) / total;
      if (expected > 0) {
        chi2 += ((observed - expected) ** 2) / expected;
      }
    });
  });

  const df = (groups.length - 1) * (outcomes.length - 1);
  const pValue = 1 - jStat.chisquare.cdf(chi2, df);
  const groupLabel = formatDisplayName(groupVar);
  const outcomeLabel = formatDisplayName(concept ? concept.label : outcomeVar);
  const tableConfig: ResultTable = {
    title: `Contingency table for ${formatComparisonLabel(groupVar, concept ? concept.label : outcomeVar)}`,
    columns: [groupLabel, ...outcomes.map((outcome) => `${outcome} (count | row %)`), 'total_n'],
    rows: groups.map((group) => {
      const baseRow: Record<string, string | number> = {
        [groupLabel]: group,
      };
      outcomes.forEach((outcome) => {
        const count = table[group][outcome] || 0;
        const percent = rowTotals[group] > 0 ? ((count / rowTotals[group]) * 100).toFixed(1) : '0.0';
        baseRow[`${outcome} (count | row %)`] = `${count} | ${percent}%`;
      });
      baseRow.total_n = rowTotals[group];
      return baseRow;
    }),
  };

  return {
    metrics: {
      test: 'Chi-Square',
      groups: groups.length,
      categories: outcomes.length,
      total_n: total,
      chi_square: chi2.toFixed(4),
      degrees_of_freedom: df,
      p_value: formatPValue(pValue),
    },
    interpretation:
      pValue < 0.05
        ? `Statistically significant association detected between ${groupLabel} and ${
            concept ? `${outcomeLabel} incidence` : outcomeLabel
          } (p=${formatPValue(pValue)}).`
        : `No statistically significant association detected between ${groupLabel} and ${
            concept ? `${outcomeLabel} incidence` : outcomeLabel
          } (p=${formatPValue(pValue)}).`,
    chartConfig: buildChiSquareHeatmap(table, groups, outcomes, rowTotals, groupVar, outcomeVar, concept),
    tableConfig,
    executedCode: `# Deterministic local execution\n# Chi-square ${groupVar} vs ${concept ? `${concept.label} incidence` : outcomeVar}`,
  };
};

export const executeLocalStatisticalAnalysis = (
  file: ClinicalFile,
  testType: StatTestType | string,
  var1: string,
  var2: string,
  concept?: AnalysisConcept | null
): StatAnalysisResult => {
  const { headers, rows } = parseCsv(file.content);
  if (rows.length === 0) {
    throw new Error('Dataset is empty.');
  }

  const outcomeVar = getOutcomeVariable(rows, var1, var2);
  const normalizedTestType = normalizeTestType(testType);

  if (!normalizedTestType) {
    throw new Error(`Unsupported test type: ${testType}`);
  }

  switch (normalizedTestType) {
    case StatTestType.T_TEST:
      return runTTest(rows, var1, outcomeVar);
    case StatTestType.CHI_SQUARE:
      return runChiSquare(rows, var1, outcomeVar, concept);
    case StatTestType.ANOVA:
      return runAnova(rows, var1, outcomeVar);
    case StatTestType.REGRESSION:
      return runRegression(rows, var1, outcomeVar);
    case StatTestType.CORRELATION:
      return runCorrelation(rows, var1, outcomeVar);
    case StatTestType.KAPLAN_MEIER:
      return runKaplanMeier(rows, headers, var1, outcomeVar);
    case StatTestType.COX_PH:
      return runCox(rows, headers, var1, outcomeVar);
    default:
      throw new Error(`Unsupported test type: ${normalizedTestType}`);
  }
};
