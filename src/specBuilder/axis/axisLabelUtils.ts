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
import { Granularity, Label, LabelAlign, LabelFormat, Position } from 'types';
import {
	Align,
	Baseline,
	EncodeEntry,
	FontWeight,
	GuideEncodeEntry,
	NumberValue,
	ProductionRule,
	ScaledValueRef,
	TextEncodeEntry,
	TextValueRef,
	TickCount,
} from 'vega';

import { isVerticalAxis } from './axisUtils';

/**
 * Gets the display value of the label. If it's an object, it will return the value property, otherwise it will return the label.
 * @param label
 * @returns string | number
 */
export const getLabelValue = (label: Label | number | string): string | number => {
	if (typeof label === 'object') {
		return label.value;
	}
	return label;
};

/**
 * Gets the label format values based on the granularity
 * @param granularity
 * @returns [secondaryFormat, primaryFormat, tickCount]
 */
export const getTimeLabelFormats = (granularity: Granularity): [string, string, TickCount] => {
	switch (granularity) {
		case 'minute':
			return ['%-I:%M %p', '%b %-d', 'minute'];
		case 'hour':
			return ['%-I %p', '%b %-d', 'hour'];
		case 'day':
			return ['%-d', '%b', 'day'];
		case 'week':
			return ['%-d', '%b', 'week'];
		case 'month':
			return ['%b', '%Y', 'month'];
		case 'quarter':
			return ['Q%q', '%Y', { interval: 'month', step: 3 }];
		default:
			return ['%-d', '%b', 'day'];
	}
};

/**
 * gets the baseline or alignment for the axis label based on the position
 * @param labelAlign
 * @param position
 * @returns
 */
export const getLabelBaselineAlign = (
	labelAlign: LabelAlign | undefined,
	position: Position
): Align | Baseline | undefined => {
	switch (position) {
		case 'top':
		case 'bottom':
			return getLabelAlign(labelAlign, position);
		case 'left':
		case 'right':
			return getLabelBaseline(labelAlign, position);
	}
};

/**
 * gets the vega labelAlign value based on the labelAlign value
 * @param labelAlign
 * @returns
 */
export const getLabelAlign = (
	labelAlign: LabelAlign | undefined,
	position: Position,
	vegaLabelAlign?: Align
): Align | undefined => {
	if (vegaLabelAlign) return vegaLabelAlign;
	if (!labelAlign) return;
	if (['top', 'bottom'].includes(position)) {
		switch (labelAlign) {
			case 'start':
				return 'left';
			case 'end':
				return 'right';
			case 'center':
			default:
				return 'center';
		}
	}
};

/**
 * gets the vega baseline value based on the labelAlign value
 * @param labelAlign
 * @returns
 */
export const getLabelBaseline = (
	labelAlign: LabelAlign | undefined,
	position: Position,
	vegaLabelBaseline?: Baseline
): Baseline | undefined => {
	if (vegaLabelBaseline) return vegaLabelBaseline;
	if (!labelAlign) return;
	if (isVerticalAxis(position)) {
		switch (labelAlign) {
			case 'start':
				return 'top';
			case 'end':
				return 'bottom';
			case 'center':
			default:
				return 'middle';
		}
	}
};

/**
 * calculates the label offset for a band scale based on the labelAlign
 * @param labelAlign
 * @param scaleName
 * @returns
 */
export const getLabelOffset = (
	labelAlign: LabelAlign,
	scaleName: string,
	vegaLabelOffset?: NumberValue
): NumberValue | undefined => {
	if (vegaLabelOffset !== undefined) return vegaLabelOffset;
	switch (labelAlign) {
		case 'start':
			return { signal: `bandwidth('${scaleName}') / -2` };
		case 'end':
			return { signal: `bandwidth('${scaleName}') / 2` };
		default:
			return undefined;
	}
};

/**
 * gets the vega label format based on the labelFormat
 * @param type
 * @returns
 */
export const getLabelFormat = (type?: LabelFormat): ProductionRule<TextValueRef> => {
	if (type === 'percentage') {
		return [{ test: 'isNumber(datum.value)', signal: "format(datum.value, '~%')" }, { signal: 'datum.value' }];
	}

	// if it's a number and greater than or equal to 1000, we want to format it in scientific notation (but with B instead of G) ex. 1K, 20M, 1.3B
	return [
		{
			test: 'isNumber(datum.value) && abs(datum.value) >= 1000',
			signal: "upper(replace(format(datum.value, '.3~s'), 'G', 'B'))",
		},
		{ signal: 'datum.value' },
	];
};

/**
 * Gets the axis label encoding
 * @param labelAlign
 * @param labelFontWeight
 * @param labelKey
 * @param position
 * @param signalName
 * @returns updateEncoding
 */
export const getAxisLabelsEncoding = (
	labelAlign: LabelAlign,
	labelFontWeight: FontWeight,
	labelKey: 'label' | 'subLabel',
	position: Position,
	signalName: string
): GuideEncodeEntry<TextEncodeEntry> => ({
	update: {
		text: [
			{
				test: `indexof(pluck(${signalName}, 'value'), datum.value) !== -1`,
				signal: `${signalName}[indexof(pluck(${signalName}, 'value'), datum.value)].${labelKey}`,
			},
			{ signal: 'datum.value' },
		],
		fontWeight: [
			{
				test: `indexof(pluck(${signalName}, 'value'), datum.value) !== -1 && ${signalName}[indexof(pluck(${signalName}, 'value'), datum.value)].fontWeight`,
				signal: `${signalName}[indexof(pluck(${signalName}, 'value'), datum.value)].fontWeight`,
			},
			// default to the primary label font weight
			{ value: labelFontWeight },
		],
		...getEncodedLabelBaselineAlign(position, signalName, labelAlign),
	},
});

/**
 * Will return the label align or baseline based on the position
 * These properties are used within the axis label encoding
 * If this is a vertical axis, it will return the correct baseline property and value
 * Otherwise, it will return the correct align property and value
 * @param position
 * @param signalName
 * @param defaultLabelAlign
 * @returns align | baseline
 */
export const getEncodedLabelBaselineAlign = (
	position: Position,
	signalName: string,
	defaultLabelAlign: LabelAlign
): EncodeEntry => {
	const productionRule: ProductionRule<ScaledValueRef<Baseline>> = [
		{
			test: `indexof(pluck(${signalName}, 'value'), datum.value) !== -1 && ${signalName}[indexof(pluck(${signalName}, 'value'), datum.value)].align`,
			signal: `${signalName}[indexof(pluck(${signalName}, 'value'), datum.value)].align`,
		},
	];
	switch (position) {
		case 'top':
		case 'bottom':
			return {
				align: [...productionRule, { value: getLabelAlign(defaultLabelAlign, position) }],
			};
		case 'left':
		case 'right':
			return {
				baseline: [...productionRule, { value: getLabelBaseline(defaultLabelAlign, position) }],
			};
	}
};
