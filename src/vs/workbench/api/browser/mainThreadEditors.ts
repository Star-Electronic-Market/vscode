/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { illegalArgument } from '../../../base/common/errors.js';
import { IDisposable, dispose, DisposableStore } from '../../../base/common/lifecycle.js';
import { equals as objectEquals } from '../../../base/common/objects.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { IRange } from '../../../editor/common/core/range.js';
import { ISelection } from '../../../editor/common/core/selection.js';
import { IDecorationOptions, IDecorationRenderOptions } from '../../../editor/common/editorCommon.js';
import { ISingleEditOperation } from '../../../editor/common/core/editOperation.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ITextEditorOptions, IResourceEditorInput, EditorActivation, EditorResolution, ITextEditorDiffInformation, isTextEditorDiffInformationEqual, ITextEditorChange } from '../../../platform/editor/common/editor.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { MainThreadTextEditor } from './mainThreadEditor.js';
import { ExtHostContext, ExtHostEditorsShape, IApplyEditsOptions, ITextDocumentShowOptions, ITextEditorConfigurationUpdate, ITextEditorPositionData, IUndoStopOptions, MainThreadTextEditorsShape, TextEditorRevealType } from '../common/extHost.protocol.js';
import { editorGroupToColumn, columnToEditorGroup, EditorGroupColumn } from '../../services/editor/common/editorGroupColumn.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { IChange } from '../../../editor/common/diff/legacyLinesDiffComputer.js';
import { IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IEditorControl } from '../../common/editor.js';
import { getCodeEditor, ICodeEditor } from '../../../editor/browser/editorBrowser.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { DirtyDiffContribution } from '../../contrib/scm/browser/dirtydiffDecorator.js';
import { IDirtyDiffModelService } from '../../contrib/scm/browser/diff.js';
import { autorun, constObservable, derived, derivedOpts, IObservable, observableFromEvent } from '../../../base/common/observable.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { isITextModel } from '../../../editor/common/model.js';
import { LineRangeMapping, lineRangeMappingFromChanges } from '../../../editor/common/diff/rangeMapping.js';

export interface IMainThreadEditorLocator {
	getEditor(id: string): MainThreadTextEditor | undefined;
	findTextEditorIdFor(editorControl: IEditorControl): string | undefined;
	getIdOfCodeEditor(codeEditor: ICodeEditor): string | undefined;
}

export class MainThreadTextEditors implements MainThreadTextEditorsShape {

	private static INSTANCE_COUNT: number = 0;

	private readonly _instanceId: string;
	private readonly _proxy: ExtHostEditorsShape;
	private readonly _toDispose = new DisposableStore();
	private _textEditorsListenersMap: { [editorId: string]: IDisposable[] };
	private _editorPositionData: ITextEditorPositionData | null;
	private _registeredDecorationTypes: { [decorationType: string]: boolean };

	constructor(
		private readonly _editorLocator: IMainThreadEditorLocator,
		extHostContext: IExtHostContext,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDirtyDiffModelService private readonly _dirtyDiffModelService: IDirtyDiffModelService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService
	) {
		this._instanceId = String(++MainThreadTextEditors.INSTANCE_COUNT);
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostEditors);

		this._textEditorsListenersMap = Object.create(null);
		this._editorPositionData = null;

		this._toDispose.add(this._editorService.onDidVisibleEditorsChange(() => this._updateActiveAndVisibleTextEditors()));
		this._toDispose.add(this._editorGroupService.onDidRemoveGroup(() => this._updateActiveAndVisibleTextEditors()));
		this._toDispose.add(this._editorGroupService.onDidMoveGroup(() => this._updateActiveAndVisibleTextEditors()));

		this._registeredDecorationTypes = Object.create(null);
	}

	dispose(): void {
		Object.keys(this._textEditorsListenersMap).forEach((editorId) => {
			dispose(this._textEditorsListenersMap[editorId]);
		});
		this._textEditorsListenersMap = Object.create(null);
		this._toDispose.dispose();
		for (const decorationType in this._registeredDecorationTypes) {
			this._codeEditorService.removeDecorationType(decorationType);
		}
		this._registeredDecorationTypes = Object.create(null);
	}

	handleTextEditorAdded(textEditor: MainThreadTextEditor): void {
		const id = textEditor.getId();
		const toDispose: IDisposable[] = [];
		toDispose.push(textEditor.onPropertiesChanged((data) => {
			this._proxy.$acceptEditorPropertiesChanged(id, data);
		}));

		const diffInformationObs = this._getTextEditorDiffInformation(textEditor);
		toDispose.push(autorun(reader => {
			const diffInformation = diffInformationObs.read(reader);
			this._proxy.$acceptEditorDiffInformation(id, diffInformation);
		}));

		this._textEditorsListenersMap[id] = toDispose;
	}

	handleTextEditorRemoved(id: string): void {
		dispose(this._textEditorsListenersMap[id]);
		delete this._textEditorsListenersMap[id];
	}

	private _updateActiveAndVisibleTextEditors(): void {

		// editor columns
		const editorPositionData = this._getTextEditorPositionData();
		if (!objectEquals(this._editorPositionData, editorPositionData)) {
			this._editorPositionData = editorPositionData;
			this._proxy.$acceptEditorPositionData(this._editorPositionData);
		}
	}

	private _getTextEditorPositionData(): ITextEditorPositionData {
		const result: ITextEditorPositionData = Object.create(null);
		for (const editorPane of this._editorService.visibleEditorPanes) {
			const id = this._editorLocator.findTextEditorIdFor(editorPane);
			if (id) {
				result[id] = editorGroupToColumn(this._editorGroupService, editorPane.group);
			}
		}
		return result;
	}

	private _getTextEditorDiffInformation(textEditor: MainThreadTextEditor): IObservable<ITextEditorDiffInformation | undefined> {
		const codeEditor = textEditor.getCodeEditor();
		if (!codeEditor) {
			return constObservable(undefined);
		}

		// Check if the TextModel belongs to a DiffEditor
		const diffEditors = this._codeEditorService.listDiffEditors();
		const [diffEditor] = diffEditors.filter(d =>
			d.getOriginalEditor().getId() === codeEditor.getId() ||
			d.getModifiedEditor().getId() === codeEditor.getId());

		const editorModelObs = diffEditor
			? observableFromEvent(this, diffEditor.onDidChangeModel, () => diffEditor.getModel())
			: observableFromEvent(this, codeEditor.onDidChangeModel, () => codeEditor.getModel());

		const editorChangesObs = derived<IObservable<{ original: URI; modified: URI; changes: LineRangeMapping[] } | undefined>>(reader => {
			const editorModel = editorModelObs.read(reader);
			if (!editorModel) {
				return constObservable(undefined);
			}

			// DiffEditor
			if (!isITextModel(editorModel)) {
				return observableFromEvent(diffEditor.onDidUpdateDiff, () => {
					const changes = diffEditor.getDiffComputationResult()?.changes2 ?? [];

					return {
						original: editorModel.original.uri,
						modified: editorModel.modified.uri,
						changes: changes.map(change => change as LineRangeMapping)
					};
				});
			}

			// TextEditor
			const dirtyDiffModel = this._dirtyDiffModelService.getOrCreateModel(editorModel.uri);
			if (!dirtyDiffModel) {
				return constObservable(undefined);
			}

			return observableFromEvent(this, dirtyDiffModel.onDidChange, () => {
				const scmQuickDiff = dirtyDiffModel.quickDiffs.find(diff => diff.isSCM === true);
				if (!scmQuickDiff) {
					return undefined;
				}

				const changes = dirtyDiffModel.changes
					.filter(change => change.label === scmQuickDiff.label)
					.map(change => change.change);

				// Convert IChange[] to LineRangeMapping[]
				const lineRangeMapping = lineRangeMappingFromChanges(changes);

				return {
					original: scmQuickDiff.originalResource,
					modified: editorModel.uri,
					changes: lineRangeMapping
				};
			});
		});

		return derivedOpts({
			owner: this,
			equalsFn: (diff1, diff2) => isTextEditorDiffInformationEqual(this._uriIdentityService, diff1, diff2)
		}, reader => {
			const editorModel = editorModelObs.read(reader);
			const editorChanges = editorChangesObs.read(reader).read(reader);
			if (!editorModel || !editorChanges) {
				return undefined;
			}

			const documentVersion = isITextModel(editorModel)
				? editorModel.getVersionId()
				: editorModel.modified.getVersionId();

			const changes: ITextEditorChange[] = editorChanges.changes
				.map(change => [
					change.original.startLineNumber,
					change.original.endLineNumberExclusive,
					change.modified.startLineNumber,
					change.modified.endLineNumberExclusive
				]);

			return {
				documentVersion,
				original: editorChanges.original,
				modified: editorChanges.modified,
				changes
			};
		});
	}

	// --- from extension host process

	async $tryShowTextDocument(resource: UriComponents, options: ITextDocumentShowOptions): Promise<string | undefined> {
		const uri = URI.revive(resource);

		const editorOptions: ITextEditorOptions = {
			preserveFocus: options.preserveFocus,
			pinned: options.pinned,
			selection: options.selection,
			// preserve pre 1.38 behaviour to not make group active when preserveFocus: true
			// but make sure to restore the editor to fix https://github.com/microsoft/vscode/issues/79633
			activation: options.preserveFocus ? EditorActivation.RESTORE : undefined,
			override: EditorResolution.EXCLUSIVE_ONLY
		};

		const input: IResourceEditorInput = {
			resource: uri,
			options: editorOptions
		};

		const editor = await this._editorService.openEditor(input, columnToEditorGroup(this._editorGroupService, this._configurationService, options.position));
		if (!editor) {
			return undefined;
		}
		// Composite editors are made up of many editors so we return the active one at the time of opening
		const editorControl = editor.getControl();
		const codeEditor = getCodeEditor(editorControl);
		return codeEditor ? this._editorLocator.getIdOfCodeEditor(codeEditor) : undefined;
	}

	async $tryShowEditor(id: string, position?: EditorGroupColumn): Promise<void> {
		const mainThreadEditor = this._editorLocator.getEditor(id);
		if (mainThreadEditor) {
			const model = mainThreadEditor.getModel();
			await this._editorService.openEditor({
				resource: model.uri,
				options: { preserveFocus: false }
			}, columnToEditorGroup(this._editorGroupService, this._configurationService, position));
			return;
		}
	}

	async $tryHideEditor(id: string): Promise<void> {
		const mainThreadEditor = this._editorLocator.getEditor(id);
		if (mainThreadEditor) {
			const editorPanes = this._editorService.visibleEditorPanes;
			for (const editorPane of editorPanes) {
				if (mainThreadEditor.matches(editorPane)) {
					await editorPane.group.closeEditor(editorPane.input);
					return;
				}
			}
		}
	}

	$trySetSelections(id: string, selections: ISelection[]): Promise<void> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setSelections(selections);
		return Promise.resolve(undefined);
	}

	$trySetDecorations(id: string, key: string, ranges: IDecorationOptions[]): Promise<void> {
		key = `${this._instanceId}-${key}`;
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setDecorations(key, ranges);
		return Promise.resolve(undefined);
	}

	$trySetDecorationsFast(id: string, key: string, ranges: number[]): Promise<void> {
		key = `${this._instanceId}-${key}`;
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setDecorationsFast(key, ranges);
		return Promise.resolve(undefined);
	}

	$tryRevealRange(id: string, range: IRange, revealType: TextEditorRevealType): Promise<void> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.revealRange(range, revealType);
		return Promise.resolve();
	}

	$trySetOptions(id: string, options: ITextEditorConfigurationUpdate): Promise<void> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setConfiguration(options);
		return Promise.resolve(undefined);
	}

	$tryApplyEdits(id: string, modelVersionId: number, edits: ISingleEditOperation[], opts: IApplyEditsOptions): Promise<boolean> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		return Promise.resolve(editor.applyEdits(modelVersionId, edits, opts));
	}

	$tryInsertSnippet(id: string, modelVersionId: number, template: string, ranges: readonly IRange[], opts: IUndoStopOptions): Promise<boolean> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		return Promise.resolve(editor.insertSnippet(modelVersionId, template, ranges, opts));
	}

	$registerTextEditorDecorationType(extensionId: ExtensionIdentifier, key: string, options: IDecorationRenderOptions): void {
		key = `${this._instanceId}-${key}`;
		this._registeredDecorationTypes[key] = true;
		this._codeEditorService.registerDecorationType(`exthost-api-${extensionId}`, key, options);
	}

	$removeTextEditorDecorationType(key: string): void {
		key = `${this._instanceId}-${key}`;
		delete this._registeredDecorationTypes[key];
		this._codeEditorService.removeDecorationType(key);
	}

	$getDiffInformation(id: string): Promise<IChange[]> {
		const editor = this._editorLocator.getEditor(id);

		if (!editor) {
			return Promise.reject(new Error('No such TextEditor'));
		}

		const codeEditor = editor.getCodeEditor();
		if (!codeEditor) {
			return Promise.reject(new Error('No such CodeEditor'));
		}

		const codeEditorId = codeEditor.getId();
		const diffEditors = this._codeEditorService.listDiffEditors();
		const [diffEditor] = diffEditors.filter(d => d.getOriginalEditor().getId() === codeEditorId || d.getModifiedEditor().getId() === codeEditorId);

		if (diffEditor) {
			return Promise.resolve(diffEditor.getLineChanges() || []);
		}

		const dirtyDiffContribution = codeEditor.getContribution('editor.contrib.dirtydiff');

		if (dirtyDiffContribution) {
			return Promise.resolve((dirtyDiffContribution as DirtyDiffContribution).getChanges());
		}

		return Promise.resolve([]);
	}
}

// --- commands

CommandsRegistry.registerCommand('_workbench.revertAllDirty', async function (accessor: ServicesAccessor) {
	const environmentService = accessor.get(IEnvironmentService);
	if (!environmentService.extensionTestsLocationURI) {
		throw new Error('Command is only available when running extension tests.');
	}

	const workingCopyService = accessor.get(IWorkingCopyService);
	for (const workingCopy of workingCopyService.dirtyWorkingCopies) {
		await workingCopy.revert({ soft: true });
	}
});
