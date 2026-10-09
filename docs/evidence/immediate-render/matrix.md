# Native mutation matrix

| Case / tool | Data and visible result | Before | Immediate |
| --- | --- | --- | --- |
| word-heading / `set_heading` | PASS: Heading visible; h1 in HTML | [image](word-heading-before.png) | [image](word-heading-immediate.png) |
| word-format / `format_range` | PASS: Full FORMATME bold/underlined; text preserved | [image](word-format-before.png) | [image](word-format-immediate.png) |
| word-replace / `replace_text` | PASS: FINDME replaced | [image](word-replace-before.png) | [image](word-replace-immediate.png) |
| word-hyperlink / `add_hyperlink` | PASS: LINK visible; href in HTML | [image](word-hyperlink-before.png) | [image](word-hyperlink-immediate.png) |
| word-hyperlink-append / `add_hyperlink` | PASS: Appended LINK visible; new paragraph | [image](word-hyperlink-append-before.png) | [image](word-hyperlink-append-immediate.png) |
| word-image / `insert_image` | PASS: 48px image visible; 457200 EMU | [image](word-image-before.png) | [image](word-image-immediate.png) |
| word-table / `insert_table` | PASS: 2x2 table and four cell texts visible | [image](word-table-before.png) | [image](word-table-immediate.png) |
| word-blocks / `insert_blocks` | PASS: Two blocks visible | [image](word-blocks-before.png) | [image](word-blocks-immediate.png) |
| word-paragraph / `insert_paragraph` | PASS: Cursor text visible | [image](word-paragraph-before.png) | [image](word-paragraph-immediate.png) |
| word-selection / `replace_selection` | PASS: Preview/Apply replacement visible | [image](word-selection-before.png) | [image](word-selection-immediate.png) |
| word-comment / `insert_comment` | PASS: Native comment popup visible; one comment | [image](word-comment-before.png) | [image](word-comment-immediate.png) |
| cell-write / `write_range` | PASS: A1:B2 values visible | [image](cell-write-before.png) | [image](cell-write-immediate.png) |
| cell-format / `format_cells` | PASS: A1 bold24/yellow; row42/column35 | [image](cell-format-before.png) | [image](cell-format-immediate.png) |
| cell-percent / `format_cells` | PASS: B1 displays 25,00%; format 0.00% | [image](cell-percent-before.png) | [image](cell-percent-immediate.png) |
| cell-rename / `rename_sheet` | PASS: Active tab RENAMED immediately | [image](cell-rename-before.png) | [image](cell-rename-immediate.png) |
| cell-add / `add_sheet` | PASS: New ADDED tab active | [image](cell-add-before.png) | [image](cell-add-immediate.png) |
| cell-rename-inactive / `rename_sheet` | PASS: Inactive tab INACTIVE; ADDED stays active | [image](cell-rename-inactive-before.png) | [image](cell-rename-inactive-immediate.png) |
| slide-text / `set_slide_text` | PASS: AFTER SLIDE visible | [image](slide-text-before.png) | [image](slide-text-immediate.png) |
| slide-format / `format_slide_text` | PASS: Red bold44 text visible; text unchanged | [image](slide-format-before.png) | [image](slide-format-immediate.png) |
| slide-table / `add_table` | PASS: 2x2 table visible; drawings +1 | [image](slide-table-before.png) | [image](slide-table-immediate.png) |
| slide-image / `add_image` | PASS: Image visible; 914400 EMU | [image](slide-image-before.png) | [image](slide-image-immediate.png) |
| slide-duplicate / `duplicate_slide` | PASS: Count 2 to3 immediately; duplicate content read back | [image](slide-duplicate-before.png) | [image](slide-duplicate-immediate.png) |
| slide-move / `move_slide` | PASS: OMEGA visible first; order read back | [image](slide-move-before.png) | [image](slide-move-immediate.png) |
| slide-add / `add_slide` | PASS: Blank active slide; count3 to4 | [image](slide-add-before.png) | [image](slide-add-immediate.png) |
