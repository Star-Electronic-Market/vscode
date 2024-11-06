/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface Option {
	name: string | string[];
	description: string;
}

export interface Arg {
	name: string;
	template?: string;
	description: string;
	isOptional?: boolean;
	generators?: () => any; // Replace with the actual type if known
	suggestions?: Suggestion[];
}

export interface Suggestion {
	name: string;
	description: string;
	hidden?: boolean;
}

export interface Subcommand {
	name: string;
	description: string;
	options?: Option[];
	args?: Arg;
	requiresSubcommand?: boolean;
	subcommands?: Subcommand[];
}

export class FigSpec {
	displayName?: string;
	name: string;
	description: string;
	subcommands: Subcommand[];
	options: Option[];
	args?: Arg;
	constructor(name: string, description: string, subcommands: Subcommand[], options: Option[]) {
		this.name = name;
		this.description = description;
		this.subcommands = subcommands;
		this.options = options;
	}
}