# Inventory Filters

Statekeep's tree search can be narrowed with structured filters. Filters work on their own or together with name/property search text, and every active condition must match.

Available filters:

- **Scope** limits results to the selected node and all of its descendants. Choose **Use selected** to capture the current primary selection; later selection changes do not silently change the scope.
- **Template** includes only nodes bound to the chosen template.
- **Property** compares one property by exact value or substring. Keys are exact and values are case-insensitive display-value comparisons, so numbers and booleans can be entered as they appear in the property editor.
- **Missing a required value** includes template-bound nodes where at least one required field is absent, null, or an empty string.

Results use the same exact count and incremental loading as text search. The tree shows loaded matches with their ancestors so hierarchy remains visible. Enter and Shift+Enter cycle through loaded results; moving forward at a page boundary loads the next page.

Clearing the search text keeps active filters. **Clear all** in the filter panel removes the filters while preserving search text. Escape from the search field removes both.

Filters are session controls and are not stored in the project document. The Tree/Table switch preserves those controls and the primary selection. Saved views remain separate roadmap work.
