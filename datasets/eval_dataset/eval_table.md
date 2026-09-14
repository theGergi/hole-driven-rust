### Results by Hole Category (failed / fit correctness)

| category | failed_with_error | failed | fit_incorrect | fit_correct | total |
| --- | --- | --- | --- | --- | --- |
| function_call | 0/64 (0.0%) | 6/64 (9.4%) | 10/64 (15.6%) | 48/64 (75.0%) | 64 |
| immutable_reference | 0/27 (0.0%) | 1/27 (3.7%) | 12/27 (44.4%) | 14/27 (51.9%) | 27 |
| index | 0/236 (0.0%) | 19/236 (8.1%) | 13/236 (5.5%) | 204/236 (86.4%) | 236 |
| method_call | 0/497 (0.0%) | 9/497 (1.8%) | 47/497 (9.5%) | 441/497 (88.7%) | 497 |
| mutable_reference | 0/1 (0.0%) | 0/1 (0.0%) | 0/1 (0.0%) | 1/1 (100.0%) | 1 |
| range | 0/110 (0.0%) | 0/110 (0.0%) | 8/110 (7.3%) | 102/110 (92.7%) | 110 |
| variable_use | 1/1663 (0.1%) | 172/1663 (10.3%) | 244/1663 (14.7%) | 1246/1663 (74.9%) | 1663 |
| **Total** | **1/2598 (0.0%)** | **207/2598 (8.0%)** | **334/2598 (12.9%)** | **2056/2598 (79.1%)** | **2598** |

### Results by Hole Category (match quality)

(avg_suggestions = mean list length over holes that produced suggestions; avg_rank = mean 1-based rank of the ground truth, over the holes where it was suggested at all)

| category | exact_match | matched_type | valid_suggestion | avg_suggestions | avg_rank |
| --- | --- | --- | --- | --- | --- |
| function_call | 37/64 (57.8%) | 44/64 (68.8%) | 0/64 (0.0%) | 121.3 | 13.2 |
| immutable_reference | 13/27 (48.1%) | 11/27 (40.7%) | 0/27 (0.0%) | 111.7 | 6.7 |
| index | 180/236 (76.3%) | 170/236 (72.0%) | 0/236 (0.0%) | 411.1 | 15.0 |
| method_call | 321/497 (64.6%) | 415/497 (83.5%) | 0/497 (0.0%) | 174.2 | 27.8 |
| mutable_reference | 1/1 (100.0%) | 0/1 (0.0%) | 0/1 (0.0%) | 1408.0 | 29.0 |
| range | 102/110 (92.7%) | 99/110 (90.0%) | 0/110 (0.0%) | 147.5 | 2.7 |
| variable_use | 1201/1663 (72.2%) | 1140/1663 (68.6%) | 0/1663 (0.0%) | 405.5 | 2.1 |
| **Total** | **1855/2598 (71.4%)** | **1879/2598 (72.3%)** | **0/2598 (0.0%)** | **337.4** | **8.1** |

