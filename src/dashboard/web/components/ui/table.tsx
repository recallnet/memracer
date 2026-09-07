import * as React from "react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

export const Table = ({ className, ...props }: ComponentProps<"table">) => <table className={cn("ui-table", className)} {...props} />;
export const TableHeader = (props: ComponentProps<"thead">) => <thead {...props} />;
export const TableBody = (props: ComponentProps<"tbody">) => <tbody {...props} />;
export const TableRow = ({ className, ...props }: ComponentProps<"tr">) => <tr className={cn("ui-table-row", className)} {...props} />;
export const TableHead = (props: ComponentProps<"th">) => <th {...props} />;
export const TableCell = (props: ComponentProps<"td">) => <td {...props} />;
