# Searchable references

The composer @ button opens a keyboard-accessible composition/layer reference picker. Choose project compositions or layers in an explicit composition, then search by name or ID. Every result shows IDs to distinguish duplicate names. Each request inspects at most one 100-item host page; Next page continues the same search through larger projects. The picker explicitly labels searches as page-scoped.

Up to eight selected references appear as removable chips before submission. They are context, and do not change the pinned/follow composition target or move the viewer. The server resolves their IDs, names, project epoch and current revision before admitting a prompt. Renamed, removed or stale references must be selected again. Sent references participate in request deduplication and are frozen into the message context; later viewer changes cannot redirect that request.

The header shows a bounded summary of layers selected in AE, including IDs. Selection is not automatically attached. Use @ to explicitly choose the context to submit. Project/conversation changes clear references; closing the picker or changing its query prevents late results from repopulating it.

Validation: 72 backend/host/target tests passed, including duplicate names, paging, renamed/deleted references, project/revision drift, server admission and no prompt on search. The browser test passed stale-response isolation, duplicate-ID selection, fixed references on send, Escape/focus restoration and 320/360/700px layouts. Existing pin/follow behavior is retained.
