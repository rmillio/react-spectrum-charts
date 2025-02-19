/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { Trendline } from '@components/Trendline';
import { FILTERED_TABLE, LINEAR_PADDING, MARK_ID, MS_PER_DAY, TRENDLINE_VALUE } from '@constants';
import { getSeriesIdTransform, getTableData } from '@specBuilder/data/dataUtils';
import { getLineHoverMarks, getLineStrokeOpacity } from '@specBuilder/line/lineMarkUtils';
import { LineMarkProps, getXProductionRule } from '@specBuilder/line/lineUtils';
import {
	getColorProductionRule,
	getLineWidthProductionRule,
	getStrokeDashProductionRule,
	hasInteractiveChildren,
	hasPopover,
	hasTooltip,
} from '@specBuilder/marks/markUtils';
import {
	getGenericSignal,
	getSeriesHoveredSignal,
	getUncontrolledHoverSignal,
} from '@specBuilder/signal/signalSpecBuilder';
import { getFacetsFromProps } from '@specBuilder/specUtils';
import { sanitizeTrendlineChildren } from '@utils';
import { produce } from 'immer';
import {
	BarSpecProps,
	LineSpecProps,
	MarkChildElement,
	TrendlineElement,
	TrendlineMethod,
	TrendlineProps,
	TrendlineSpecProps,
} from 'types';
import {
	Data,
	FilterTransform,
	FormulaTransform,
	GroupMark,
	JoinAggregateTransform,
	LineMark,
	LookupTransform,
	RegressionMethod,
	RegressionTransform,
	Scale,
	ScaleType,
	Signal,
	SourceData,
	Transforms,
	WindowTransform,
} from 'vega';

export const getTrendlines = (children: MarkChildElement[], markName: string): TrendlineSpecProps[] => {
	const trendlineElements = children.filter((child) => child.type === Trendline) as TrendlineElement[];
	return trendlineElements.map((trendline, index) => applyTrendlinePropDefaults(trendline.props, markName, index));
};

export const applyTrendlinePropDefaults = (
	{
		children,
		dimensionRange = [null, null],
		displayOnHover = false,
		highlightRawPoint = false,
		lineType = 'dashed',
		lineWidth = 'M',
		method = 'linear',
		opacity = 1,
		...props
	}: TrendlineProps,
	markName: string,
	index: number
): TrendlineSpecProps => ({
	children: sanitizeTrendlineChildren(children),
	displayOnHover,
	dimensionRange,
	highlightRawPoint,
	lineType,
	lineWidth,
	method,
	metric: TRENDLINE_VALUE,
	name: `${markName}Trendline${index}`,
	opacity,
	...props,
});

export const getTrendlineMarks = (markProps: LineSpecProps): GroupMark[] => {
	const { children, color, lineType, name } = markProps;
	const { facets } = getFacetsFromProps({ color, lineType });

	const marks: GroupMark[] = [];
	const trendlines = getTrendlines(children, name);
	for (const trendlineProps of trendlines) {
		const dataSuffix = isRegressionMethod(trendlineProps.method) ? '_highResolutionData' : '_data';
		marks.push({
			name: `${trendlineProps.name}_group`,
			type: 'group',
			clip: true,
			from: {
				facet: {
					name: `${trendlineProps.name}_facet`,
					data: trendlineProps.name + dataSuffix,
					groupby: facets,
				},
			},
			marks: [getTrendlineLineMark(markProps, trendlineProps)],
		});
	}

	if (trendlines.some((trendline) => hasTooltip(trendline.children))) {
		marks.push(
			getTrendlineHoverMarks(
				markProps,
				trendlines.some((trendlineProps) => trendlineProps.highlightRawPoint)
			)
		);
	}

	return marks;
};

const getTrendlineLineMark = (markProps: LineSpecProps, trendlineProps: TrendlineSpecProps): LineMark => {
	const { colorScheme, dimension, scaleType } = markProps;
	const { displayOnHover, lineType, lineWidth, metric, name, opacity } = trendlineProps;
	const x =
		scaleType === 'time'
			? { scale: 'xTrendline', field: `${dimension}Normalized` }
			: getXProductionRule(scaleType, dimension);
	const color = trendlineProps.color ? { value: trendlineProps.color } : markProps.color;

	return {
		name,
		type: 'line',
		from: { data: `${name}_facet` },
		interactive: false,
		encode: {
			enter: {
				y: { scale: 'yLinear', field: metric },
				stroke: getColorProductionRule(color, colorScheme),
				strokeDash: getStrokeDashProductionRule({ value: lineType }),
				strokeWidth: getLineWidthProductionRule({ value: lineWidth }),
			},
			update: {
				x,
				strokeOpacity: getLineStrokeOpacity({
					...markProps,
					displayOnHover,
					opacity: { value: opacity },
				}),
			},
		},
	};
};

const getTrendlineHoverMarks = (lineProps: LineSpecProps, highlightRawPoint: boolean): GroupMark => {
	const { children, metric, name } = lineProps;
	const trendlines = getTrendlines(children, name);
	const trendlineHoverProps: LineMarkProps = {
		...lineProps,
		name: `${name}Trendline`,
		children: trendlines.map((trendline) => trendline.children).flat(),
		metric: TRENDLINE_VALUE,
	};
	return {
		name: `${name}Trendline_hoverGroup`,
		type: 'group',
		clip: true,
		marks: getLineHoverMarks(
			trendlineHoverProps,
			`${name}_allTrendlineData`,
			highlightRawPoint ? metric : undefined
		),
	};
};

/**
 * Adds the necessary data sources and transforms for the trendlines
 * NOTE: this function mutates the data array because it gets called from within a data produce function
 * @param data
 * @param markProps
 */
export const addTrendlineData = (data: Data[], markProps: BarSpecProps | LineSpecProps) => {
	const { dimension } = markProps;
	data.push(...getTrendlineData(markProps));
	const trendlines = getTrendlines(markProps.children, markProps.name);

	// only need to add the normalized dimension transform if there is a regression trendline and the dimension is time
	const hasRegressionTrendline = trendlines.some((trendline) => isRegressionMethod(trendline.method));
	const hasTimeScale = 'scaleType' in markProps && markProps.scaleType === 'time';

	if (hasRegressionTrendline && hasTimeScale) {
		const tableData = getTableData(data);
		tableData.transform = addNormalizedDimensionTransform(tableData.transform ?? [], dimension);
	}
};

const addNormalizedDimensionTransform = produce<Transforms[], [string]>((transforms, dimension) => {
	if (transforms.findIndex((transform) => 'as' in transform && transform.as === `${dimension}Normalized`) === -1) {
		transforms.push({
			type: 'joinaggregate',
			fields: [dimension],
			as: [`${dimension}Min`],
			ops: ['min'],
		});
		transforms.push({
			type: 'formula',
			expr: `(datum.${dimension} - datum.${dimension}Min + ${MS_PER_DAY}) / ${MS_PER_DAY}`,
			as: `${dimension}Normalized`,
		});
	}
});

/**
 * adds the data transforms and data sources for the trendlines
 * @param data
 * @param markProps
 */
export const getTrendlineData = (markProps: BarSpecProps | LineSpecProps): SourceData[] => {
	const data: SourceData[] = [];
	const { children, color, dimension, lineType, name: markName } = markProps;
	const scaleType = 'scaleType' in markProps ? markProps.scaleType : undefined;
	const trendlines = getTrendlines(children, markName);

	const concatenatedTrendlineData: { name: string; source: string[] } = {
		name: `${markName}_allTrendlineData`,
		source: [],
	};

	for (const trendlineProps of trendlines) {
		const { children: trendlineChildren, method, name, dimensionRange } = trendlineProps;
		const dimensionRangeTransforms = getTrendlineDimensionRangeTransforms(dimension, dimensionRange);
		const { facets } = getFacetsFromProps({ color, lineType });

		if (isRegressionMethod(method)) {
			data.push({
				name: `${name}_highResolutionData`,
				source: FILTERED_TABLE,
				transform: [
					...dimensionRangeTransforms,
					...getTrendlineStatisticalTransforms(markProps, trendlineProps),
					getSeriesIdTransform(facets),
				],
			});
			if (hasInteractiveChildren(trendlineChildren)) {
				data.push(
					{
						name: `${name}_params`,
						source: FILTERED_TABLE,
						transform: [
							...dimensionRangeTransforms,
							...getTrendlineStatisticalTransforms(markProps, trendlineProps, true),
						],
					},
					{
						name: `${name}_data`,
						source: FILTERED_TABLE,
						transform: [
							...dimensionRangeTransforms,
							getTrendlineParamLookupTransform(markProps, trendlineProps),
							...getTrendlineParamFormulaTransforms(dimension, method, scaleType),
						],
					}
				);
			}
		} else if (method === 'average') {
			data.push({
				name: `${name}_data`,
				source: FILTERED_TABLE,
				transform: [
					...dimensionRangeTransforms,
					...getTrendlineStatisticalTransforms(markProps, trendlineProps),
				],
			});
		} else if (isWindowMethod(method)) {
			// we want to filter down to the dimension range after calculating the moving average
			data.push({
				name: `${name}_data`,
				source: FILTERED_TABLE,
				transform: [
					...getTrendlineStatisticalTransforms(markProps, trendlineProps),
					...dimensionRangeTransforms,
				],
			});
		}
		if (hasInteractiveChildren(trendlineChildren)) {
			concatenatedTrendlineData.source.push(`${name}_data`);
		}
	}

	if (trendlines.some((trendline) => hasInteractiveChildren(trendline.children))) {
		data.push(concatenatedTrendlineData);

		const selectSignal = `${markName}Trendline_selectedId`;
		const hoverSignal = `${markName}Trendline_hoveredId`;
		const trendlineHasPopover = trendlines.some((trendline) => hasPopover(trendline.children));
		const expr = trendlineHasPopover
			? `${selectSignal} === datum.${MARK_ID} || !${selectSignal} && ${hoverSignal} === datum.${MARK_ID}`
			: `${hoverSignal} === datum.${MARK_ID}`;

		data.push({
			name: `${markName}Trendline_highlightedData`,
			source: `${markName}_allTrendlineData`,
			transform: [
				{
					type: 'filter',
					expr,
				},
			],
		});
	}

	return data;
};

/**
 * gets the filter transforms that will restrict the data to the dimension range
 * @param dimension
 * @param dimensionRange
 * @returns filterTansforms
 */
export const getTrendlineDimensionRangeTransforms = (
	dimension: string,
	dimensionRange: [number | null, number | null]
): FilterTransform[] => {
	const filterExpressions: string[] = [];
	if (dimensionRange[0] !== null) {
		filterExpressions.push(`datum.${dimension} >= ${dimensionRange[0]}`);
	}
	if (dimensionRange[1] !== null) {
		filterExpressions.push(`datum.${dimension} <= ${dimensionRange[1]}`);
	}
	if (filterExpressions.length) {
		return [
			{
				type: 'filter',
				expr: filterExpressions.join(' && '),
			},
		];
	}
	return [];
};

const getTrendlineParamLookupTransform = (
	{ color, lineType }: BarSpecProps | LineSpecProps,
	{ name }: TrendlineSpecProps
): LookupTransform => {
	const { facets } = getFacetsFromProps({ color, lineType });
	return {
		type: 'lookup',
		from: `${name}_params`,
		key: 'keys',
		fields: facets,
		values: ['coef'],
	};
};

/**
 * This transform is used to calculate the value of the trendline using the coef and the dimension
 * @param dimension mark dimension
 * @param method trenline method
 * @returns formula transorfm
 */
export const getTrendlineParamFormulaTransforms = (
	dimension: string,
	method: TrendlineMethod,
	scaleType: ScaleType | undefined
): FormulaTransform[] => {
	let expr = '';
	const trendlineDimension = scaleType === 'time' ? `${dimension}Normalized` : dimension;
	if (isPolynomialMethod(method)) {
		const order = getPolynomialOrder(method);
		expr = [
			'datum.coef[0]',
			...Array(order)
				.fill(0)
				.map((_e, i) => `datum.coef[${i + 1}] * pow(datum.${trendlineDimension}, ${i + 1})`),
		].join(' + ');
	} else if (method === 'exponential') {
		expr = `datum.coef[0] + exp(datum.coef[1] * datum.${trendlineDimension})`;
	} else if (method === 'logarithmic') {
		expr = `datum.coef[0] + datum.coef[1] * log(datum.${trendlineDimension})`;
	} else if (method === 'power') {
		expr = `datum.coef[0] * pow(datum.${trendlineDimension}, datum.coef[1])`;
	}

	if (!expr) return [];
	return [
		{
			type: 'formula',
			expr,
			as: TRENDLINE_VALUE,
		},
	];
};

export const getTrendlineScales = (props: LineSpecProps | BarSpecProps): Scale[] => {
	const { children, dimension, name } = props;
	const trendlines = getTrendlines(children, name);
	if (trendlines.length && 'scaleType' in props && props.scaleType === 'time') {
		return [
			{
				name: 'xTrendline',
				type: 'linear',
				range: 'width',
				domain: { data: FILTERED_TABLE, fields: [`${dimension}Normalized`] },
				padding: LINEAR_PADDING,
				zero: false,
				nice: false,
			},
		];
	}
	return [];
};

/**
 * determines if the supplied method is a polynomial method
 * @see https://vega.github.io/vega/docs/transforms/regression/
 * @param method regression method
 * @returns boolean
 */
const isPolynomialMethod = (method: TrendlineMethod): boolean =>
	method.startsWith('polynomial-') || ['linear', 'quadratic'].includes(method);

/**
 * determines if the supplied method is a regression method
 * @see https://vega.github.io/vega/docs/transforms/regression/
 * @param method regression method
 * @returns boolean
 */
const isRegressionMethod = (method: TrendlineMethod): boolean =>
	isPolynomialMethod(method) || ['exponential', 'logarithmic', 'power'].includes(method);

/**
 * determines if the supplied method is a windowing method
 * @see https://vega.github.io/vega/docs/transforms/window/
 * @param method regression method
 * @returns boolean
 */
const isWindowMethod = (method: TrendlineMethod): boolean => method.startsWith('movingAverage-');

/**
 * gets the statistical transforms that will calculate the trendline values
 * @param markProps
 * @param trendlineProps
 * @returns dataTransforms
 */
const getTrendlineStatisticalTransforms = (
	markProps: BarSpecProps | LineSpecProps,
	{ method }: TrendlineSpecProps,
	params: boolean = false
): Transforms[] => {
	if (method === 'average') {
		return [getAverageTransform(markProps)];
	}
	if (isRegressionMethod(method)) {
		return [getRegressionTransform(markProps, method, params)];
	}
	if (isWindowMethod(method)) {
		return [getMovingAverageTransform(markProps, method)];
	}

	return [];
};

/**
 * gets the join aggreagate transform used for calculating the average trendline
 * @param facets data facets
 * @param metric data y key
 * @returns JoinAggregateTransform
 */
export const getAverageTransform = ({
	color,
	lineType,
	metric,
}: BarSpecProps | LineSpecProps): JoinAggregateTransform => {
	const { facets } = getFacetsFromProps({ color, lineType });
	return {
		type: 'joinaggregate',
		groupby: facets,
		ops: ['mean'],
		fields: [metric],
		as: [TRENDLINE_VALUE],
	};
};

/**
 * gets the regression transform used for calculating the regression trendline
 * regression trendlines are ones that use the x value as a parameter
 * @see https://vega.github.io/vega/docs/transforms/regression/
 * @param markProps
 * @param method
 * @param params
 * @returns
 */
export const getRegressionTransform = (
	markProps: BarSpecProps | LineSpecProps,
	method: TrendlineMethod,
	params: boolean
): RegressionTransform => {
	const { color, dimension, lineType, metric } = markProps;
	const { facets } = getFacetsFromProps({ color, lineType });

	let regressionMethod: RegressionMethod | undefined;
	let order: number | undefined;

	switch (method) {
		case 'exponential':
			regressionMethod = 'exp';
			break;
		case 'logarithmic':
			regressionMethod = 'log';
			break;
		case 'power':
			regressionMethod = 'pow';
			break;
		default:
			order = getPolynomialOrder(method);
			regressionMethod = 'poly';
			break;
	}

	let trendlineDimension = dimension;
	if ('scaleType' in markProps && markProps.scaleType === 'time') {
		trendlineDimension += 'Normalized';
	}

	return {
		type: 'regression',
		method: regressionMethod,
		order,
		groupby: facets,
		x: trendlineDimension,
		y: metric,
		as: params ? undefined : [trendlineDimension, TRENDLINE_VALUE],
		params,
	};
};
/**
 * gets the order of the polynomial
 * y = a + b * x + … + k * pow(x, order)
 * @see https://vega.github.io/vega/docs/transforms/regression/
 * @param method trendline method
 * @returns order
 */
export const getPolynomialOrder = (method: TrendlineMethod): number => {
	// method is one of the named polynomial methods
	switch (method) {
		case 'linear':
			return 1;
		case 'quadratic':
			return 2;
	}

	// method is of the form polynomial-<order>
	const order = parseInt(method.split('-')[1]);
	if (order < 1) {
		throw new Error(`Invalid polynomial order: ${order}, order must be an interger greater than 0`);
	}
	return order;
};

export const getMovingAverageTransform = (
	markProps: BarSpecProps | LineSpecProps,
	method: TrendlineMethod
): WindowTransform => {
	const frameWidth = parseInt(method.split('-')[1]);

	const { color, lineType, metric } = markProps;
	const { facets } = getFacetsFromProps({ color, lineType });

	if (isNaN(frameWidth) || frameWidth < 1) {
		throw new Error(
			`Invalid moving average frame width: ${frameWidth}, frame width must be an integer greater than 0`
		);
	}
	return {
		type: 'window',
		ops: ['mean'],
		groupby: facets,
		fields: [metric],
		as: [TRENDLINE_VALUE],
		frame: [frameWidth - 1, 0],
	};
};

export const getTrendlineSignals = (markProps: BarSpecProps | LineSpecProps): Signal[] => {
	const signals: Signal[] = [];
	const { children, name: markName } = markProps;
	const trendlines = getTrendlines(children, markName);

	if (trendlines.some((trendline) => hasTooltip(trendline.children))) {
		signals.push(getUncontrolledHoverSignal(`${markName}Trendline`, true, `${markName}Trendline_voronoi`));
		signals.push(getSeriesHoveredSignal(`${markName}Trendline`, true, `${markName}Trendline_voronoi`));
	}

	if (trendlines.some((trendline) => trendline.displayOnHover)) {
		signals.push(getSeriesHoveredSignal(markName, true, `${markName}_voronoi`));
	}

	if (trendlines.some((trendline) => hasPopover(trendline.children))) {
		signals.push(getGenericSignal(`${markName}Trendline_selectedId`));
		signals.push(getGenericSignal(`${markName}Trendline_selectedSeries`));
	}

	return signals;
};
