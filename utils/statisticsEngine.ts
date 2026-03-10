import { jStat } from 'jstat';
import * as ss from 'simple-statistics';
import { AnalysisConcept, ClinicalFile, ResultTable, StatAnalysisResult, StatTestType } from '../types';
import { CsvRow, getNumericPairs, parseCsv, toNumber } from './dataProcessing';
import { formatChartTitle, formatComparisonLabel, formatDisplayName } from './displayNames';

const normalizeTestType = (raw: string): StatTestType | null => {
  const value = raw.toLowerCase().replace(/[_\s]+/g, ' ').trim();
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
  const { rows } = parseCsv(file.content);
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
    default:
      throw new Error(`Unsupported test type: ${normalizedTestType}`);
  }
};
